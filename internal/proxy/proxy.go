// Package proxy is the fault-injecting reverse proxy that sits between an
// application and the PayPal REST API (sandbox only) or the bundled mock.
package proxy

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/shangai2405/paychaos/internal/audit"
	"github.com/shangai2405/paychaos/internal/chaos"
	"github.com/shangai2405/paychaos/internal/money"
)

const maxBody = 1 << 20 // PayPal request bodies are small JSON documents

// TokenPath is PayPal's OAuth 2.0 token endpoint. Requests to it carry the
// client secret; their bodies are never logged, audited or streamed.
const TokenPath = "/v1/oauth2/token"

// SandboxHosts are the PayPal hosts paychaos will forward to. Access tokens
// carry no sandbox/live marker, so the live-money guard is this allowlist:
// anything else is refused when the proxy is built, before any traffic.
var SandboxHosts = []string{"api-m.sandbox.paypal.com", "api.sandbox.paypal.com"}

// hop-by-hop headers are not forwarded (RFC 9110 §7.6.1).
var hopHeaders = []string{
	"Connection", "Proxy-Connection", "Keep-Alive", "Proxy-Authenticate",
	"Proxy-Authorization", "Te", "Trailer", "Transfer-Encoding", "Upgrade",
}

// Options configures a Proxy.
type Options struct {
	Upstream *url.URL
	Engine   *chaos.Engine
	Auditor  *audit.Auditor
	Logger   *slog.Logger
	// AllowedHosts are extra upstream hosts (host or host:port) accepted
	// besides SandboxHosts: the built-in mock, or a mock started separately.
	AllowedHosts []string
	Client       *http.Client
}

// Proxy implements http.Handler.
type Proxy struct {
	opt Options

	mu       sync.Mutex
	accounts map[string]string // HashSecret(access token) -> HashSecret(client id)
}

// ErrHostNotAllowed is returned by New for an upstream outside the allowlist.
var ErrHostNotAllowed = errors.New("upstream host is not a PayPal sandbox host")

// HostAllowed reports whether u may be used as the upstream.
func HostAllowed(u *url.URL, extra []string) bool {
	if u == nil {
		return false
	}
	host := strings.ToLower(u.Hostname())
	for _, h := range SandboxHosts {
		if host == h && u.Scheme == "https" {
			return true
		}
	}
	for _, h := range extra {
		h = strings.ToLower(h)
		if h == strings.ToLower(u.Host) || h == host {
			return true
		}
	}
	return false
}

// New returns a proxy. Upstream, Engine and Auditor are required, and the
// upstream must be a sandbox host or listed in AllowedHosts.
func New(opt Options) (*Proxy, error) {
	if opt.Upstream == nil || opt.Engine == nil || opt.Auditor == nil {
		return nil, errors.New("proxy: upstream, engine and auditor are required")
	}
	if !HostAllowed(opt.Upstream, opt.AllowedHosts) {
		return nil, fmt.Errorf("%w: %s (allowed: %s over https, or the built-in mock). paychaos refuses anything that could move real money",
			ErrHostNotAllowed, opt.Upstream.Host, strings.Join(SandboxHosts, ", "))
	}
	if opt.Logger == nil {
		opt.Logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	if opt.Client == nil {
		opt.Client = &http.Client{
			Timeout: 80 * time.Second,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return http.ErrUseLastResponse
			},
		}
	}
	return &Proxy{opt: opt, accounts: map[string]string{}}, nil
}

// credentials returns a label for the account that sent r and, for bearer
// auth, a label for the access token itself. Neither is reversible. Bearer
// tokens are mapped back to the client id that obtained them through this
// proxy, so a retry made after a token refresh still groups with the original.
func (p *Proxy) credentials(r *http.Request) (account, tokenLabel string) {
	auth := r.Header.Get("Authorization")
	if strings.HasPrefix(auth, "Bearer ") {
		tok := strings.TrimSpace(strings.TrimPrefix(auth, "Bearer "))
		if tok == "" {
			return "", ""
		}
		tokenLabel = audit.HashSecret(tok)
		p.mu.Lock()
		acct, ok := p.accounts[tokenLabel]
		p.mu.Unlock()
		if ok {
			return acct, tokenLabel
		}
		return "tok:" + tokenLabel, tokenLabel
	}
	if u, _, ok := r.BasicAuth(); ok {
		return "client:" + audit.HashSecret(u), ""
	}
	return "", ""
}

// ServeHTTP applies at most one fault per request and records it for auditing.
func (p *Proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == TokenPath {
		p.serveToken(w, r)
		return
	}
	account, tokenLabel := p.credentials(r)

	body, err := io.ReadAll(io.LimitReader(r.Body, maxBody+1))
	if err != nil {
		paypalError(w, http.StatusBadRequest, "INVALID_REQUEST", "", "could not read request body")
		return
	}
	if len(body) > maxBody {
		paypalError(w, http.StatusRequestEntityTooLarge, "INVALID_REQUEST", "", "request body too large")
		return
	}

	audited := p.opt.Auditor.IsMutating(r.Method, r.URL.Path)
	seq := 0
	if audited {
		seq = p.opt.Auditor.BeginRequest(account, r.Method, r.URL.Path, r.Header.Get("Content-Type"), r.Header.Get(audit.RequestIDHeader), body)
	} else {
		p.opt.Auditor.Observe(r.Method, r.URL.Path)
	}
	p.opt.Auditor.TokenUsed(tokenLabel, r.Method, r.URL.Path, seq)

	d := p.opt.Engine.Decide(r.Method, r.URL.Path)
	var moved money.Amount // set once the upstream's response is read
	complete := func(status int, committed bool, objectID, issue string) {
		if audited {
			p.opt.Auditor.CompleteWith(seq, audit.Outcome{Rule: d.Rule, Fault: d.Fault, UpstreamStatus: status,
				Committed: committed, ObjectID: objectID, Issue: issue, Amount: moved})
		}
	}
	log := p.opt.Logger.With("seq", seq, "method", r.Method, "path", r.URL.Path, "fault", d.Fault, "rule", d.Rule)

	switch d.Fault {
	case chaos.FaultTokenExpired:
		if tokenLabel != "" {
			p.opt.Auditor.TokenRejected(tokenLabel, r.Method, r.URL.Path, seq)
		}
		complete(0, false, "", "")
		log.Info("injected 401 invalid_token")
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("WWW-Authenticate", `Bearer error="invalid_token"`)
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(map[string]string{
			"error": "invalid_token", "error_description": "The token passed in was expired (injected by paychaos)"})
		return

	case chaos.FaultError500:
		complete(0, false, "", "")
		log.Info("injected 500")
		paypalError(w, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "",
			"An internal server error has occurred (injected by paychaos).")
		return

	case chaos.FaultRateLimit:
		complete(0, false, "", "")
		log.Info("injected 429")
		paypalError(w, http.StatusTooManyRequests, "RATE_LIMIT_REACHED", "",
			"Too many requests. Blocked due to rate limiting (injected by paychaos).")
		return

	case chaos.FaultTimeoutBeforeForward:
		log.Info("stalling, then 504 without forwarding", "delay", d.Delay)
		select {
		case <-time.After(d.Delay):
		case <-r.Context().Done():
		}
		complete(0, false, "", "")
		paypalError(w, http.StatusGatewayTimeout, "GATEWAY_TIMEOUT", "", "paychaos injected a gateway timeout")
		return

	case chaos.FaultLatency:
		log.Info("adding latency", "delay", d.Delay)
		select {
		case <-time.After(d.Delay):
		case <-r.Context().Done():
			complete(0, false, "", "")
			return
		}
	}

	// For faults that cut the client off or make it give up, the upstream call
	// must outlive the client; detach it from the client's context.
	ctx := r.Context()
	if d.Fault == chaos.FaultDropAfterCommit || d.Fault == chaos.FaultHoldResponse || d.Fault == chaos.FaultTruncateAfterCommit {
		ctx = context.WithoutCancel(ctx)
	}
	resp, err := p.forward(ctx, r, body)
	if err != nil {
		complete(0, false, "", "")
		log.Warn("upstream error", "err", err)
		paypalError(w, http.StatusBadGateway, "BAD_GATEWAY", "", "paychaos could not reach the upstream: "+err.Error())
		return
	}
	defer resp.Body.Close()
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		complete(resp.StatusCode, false, "", "")
		paypalError(w, http.StatusBadGateway, "BAD_GATEWAY", "", "paychaos could not read the upstream response")
		return
	}
	committed := resp.StatusCode >= 200 && resp.StatusCode < 300
	objectID, issue := "", ""
	if committed {
		objectID = CreatedID(respBody)
		if audited {
			moved, _ = money.FromResponse(audit.Operation(r.Method, r.URL.Path), respBody)
		}
	} else {
		issue = errorIssue(respBody)
	}

	switch d.Fault {
	case chaos.FaultDropAfterCommit:
		// Record before cutting the connection so the client's retry, which
		// can only start after the reset, already sees a committed attempt.
		complete(resp.StatusCode, committed, objectID, issue)
		log.Info("upstream committed; resetting client connection", "upstream_status", resp.StatusCode)
		resetConnection(w)
		return

	case chaos.FaultTruncateAfterCommit:
		complete(resp.StatusCode, committed, objectID, issue)
		log.Info("upstream committed; truncating the response body", "upstream_status", resp.StatusCode)
		truncateResponse(w, resp, respBody)
		return

	case chaos.FaultError500AfterCommit:
		complete(resp.StatusCode, committed, objectID, issue)
		log.Info("upstream answered; telling the client 500", "upstream_status", resp.StatusCode)
		paypalError(w, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "",
			"An internal server error has occurred (injected by paychaos after the upstream processed the request).")
		return

	case chaos.FaultHoldResponse:
		// Record first: a client that times out may retry while we hold.
		complete(resp.StatusCode, committed, objectID, issue)
		log.Info("holding upstream response", "delay", d.Delay, "upstream_status", resp.StatusCode)
		select {
		case <-time.After(d.Delay):
		case <-r.Context().Done():
			log.Info("client gave up before the held response was delivered")
			return
		}
		if writeResponse(w, resp, respBody) == nil && audited {
			p.opt.Auditor.MarkDelivered(seq)
		}
		return
	}

	complete(resp.StatusCode, committed, objectID, issue)
	_ = writeResponse(w, resp, respBody)
}

// serveToken passes an OAuth token request through untouched: no faults, no
// audit, no logging of the body. It learns which client id each issued access
// token belongs to, keeping only hashes of both.
func (p *Proxy) serveToken(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, maxBody))
	if err != nil {
		paypalError(w, http.StatusBadRequest, "INVALID_REQUEST", "", "could not read request body")
		return
	}
	resp, err := p.forward(r.Context(), r, body)
	if err != nil {
		paypalError(w, http.StatusBadGateway, "BAD_GATEWAY", "", "paychaos could not reach the upstream token endpoint")
		return
	}
	defer resp.Body.Close()
	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		paypalError(w, http.StatusBadGateway, "BAD_GATEWAY", "", "paychaos could not read the token response")
		return
	}
	if clientID, _, ok := r.BasicAuth(); ok && resp.StatusCode == http.StatusOK {
		var tok struct {
			AccessToken string `json:"access_token"`
		}
		if json.Unmarshal(respBody, &tok) == nil && tok.AccessToken != "" {
			p.mu.Lock()
			p.accounts[audit.HashSecret(tok.AccessToken)] = "client:" + audit.HashSecret(clientID)
			p.mu.Unlock()
		}
	}
	p.opt.Logger.Info("oauth token request passed through", "status", resp.StatusCode)
	_ = writeResponse(w, resp, respBody)
}

func writeResponse(w http.ResponseWriter, resp *http.Response, body []byte) error {
	copyHeaders(w.Header(), resp.Header)
	w.WriteHeader(resp.StatusCode)
	_, err := w.Write(body)
	if err == nil {
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
	}
	return err
}

func (p *Proxy) forward(ctx context.Context, r *http.Request, body []byte) (*http.Response, error) {
	target := *p.opt.Upstream
	target.Path = strings.TrimSuffix(target.Path, "/") + r.URL.Path
	target.RawQuery = r.URL.RawQuery
	out, err := http.NewRequestWithContext(ctx, r.Method, target.String(), bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	copyHeaders(out.Header, r.Header)
	out.Header.Del("Accept-Encoding") // keep bodies readable for the audit log
	return p.opt.Client.Do(out)
}

// resetConnection hijacks the client connection and closes it with a TCP RST,
// which is what a client sees when a load balancer or flaky network drops a
// response mid-flight. Falls back to an empty 502 when hijacking is impossible
// (for example HTTP/2).
func resetConnection(w http.ResponseWriter) {
	hj, ok := w.(http.Hijacker)
	if !ok {
		w.WriteHeader(http.StatusBadGateway)
		return
	}
	conn, _, err := hj.Hijack()
	if err != nil {
		w.WriteHeader(http.StatusBadGateway)
		return
	}
	if tc, ok := conn.(*net.TCPConn); ok {
		_ = tc.SetLinger(0)
	}
	_ = conn.Close()
}

// truncateResponse sends the upstream's status line and headers, announcing the
// full Content-Length, then only the first half of the body before resetting
// the connection. The client has a success status in hand but a body it cannot
// parse, the way a proxy or load balancer dying mid-transfer looks. Without
// hijacking it falls back to net/http, which closes the connection when fewer
// bytes than Content-Length are written.
func truncateResponse(w http.ResponseWriter, resp *http.Response, body []byte) {
	partial := body[:len(body)/2]
	hj, ok := w.(http.Hijacker)
	if !ok {
		copyHeaders(w.Header(), resp.Header)
		w.Header().Set("Content-Length", strconv.Itoa(len(body)))
		w.WriteHeader(resp.StatusCode)
		_, _ = w.Write(partial)
		return
	}
	conn, buf, err := hj.Hijack()
	if err != nil {
		return
	}
	h := http.Header{}
	copyHeaders(h, resp.Header)
	h.Set("Content-Length", strconv.Itoa(len(body)))
	fmt.Fprintf(buf, "HTTP/1.1 %d %s\r\n", resp.StatusCode, http.StatusText(resp.StatusCode))
	_ = h.Write(buf)
	_, _ = buf.WriteString("\r\n")
	_, _ = buf.Write(partial)
	_ = buf.Flush()
	if tc, ok := conn.(*net.TCPConn); ok {
		_ = tc.SetLinger(0)
	}
	_ = conn.Close()
}

func copyHeaders(dst, src http.Header) {
	for k, vs := range src {
		dst[k] = append([]string(nil), vs...)
	}
	for _, h := range hopHeaders {
		dst.Del(h)
	}
	dst.Del("Content-Length")
}

// CreatedID returns the id of the money-moving resource a PayPal response
// describes. A capture-order or authorize-order response is an order whose
// top-level id is the order id; the capture or authorization it created sits
// in purchase_units[].payments, so that is preferred. A payout response keeps
// its id in batch_header.payout_batch_id. Everything else uses the top-level
// id. Confirm the capture-order shape against the sandbox (build plan,
// "Verify in sandbox first").
func CreatedID(body []byte) string {
	var obj struct {
		ID            string `json:"id"`
		PurchaseUnits []struct {
			Payments struct {
				Captures       []struct{ ID string } `json:"captures"`
				Authorizations []struct{ ID string } `json:"authorizations"`
			} `json:"payments"`
		} `json:"purchase_units"`
		BatchHeader struct {
			PayoutBatchID string `json:"payout_batch_id"`
		} `json:"batch_header"`
	}
	if json.Unmarshal(body, &obj) != nil {
		return ""
	}
	for _, pu := range obj.PurchaseUnits {
		if n := len(pu.Payments.Captures); n > 0 && pu.Payments.Captures[n-1].ID != "" {
			return pu.Payments.Captures[n-1].ID
		}
		if n := len(pu.Payments.Authorizations); n > 0 && pu.Payments.Authorizations[n-1].ID != "" {
			return pu.Payments.Authorizations[n-1].ID
		}
	}
	if obj.BatchHeader.PayoutBatchID != "" {
		return obj.BatchHeader.PayoutBatchID
	}
	return obj.ID
}

// errorIssue returns details[0].issue from a PayPal error body, or "".
func errorIssue(body []byte) string {
	var e struct {
		Name    string `json:"name"`
		Details []struct {
			Issue string `json:"issue"`
		} `json:"details"`
	}
	if json.Unmarshal(body, &e) != nil {
		return ""
	}
	if len(e.Details) > 0 {
		return e.Details[0].Issue
	}
	return ""
}

func debugID() string {
	b := make([]byte, 7)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// paypalError writes an error in PayPal's REST error shape.
func paypalError(w http.ResponseWriter, status int, name, issue, msg string) {
	e := map[string]any{"name": name, "message": msg, "debug_id": "paychaos-" + debugID()}
	if issue != "" {
		e["details"] = []map[string]string{{"issue": issue, "description": msg}}
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Paypal-Debug-Id", e["debug_id"].(string))
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(e)
}

// String is used in logs.
func (p *Proxy) String() string { return fmt.Sprintf("paychaos proxy -> %s", p.opt.Upstream) }
