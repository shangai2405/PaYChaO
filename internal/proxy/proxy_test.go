package proxy

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/shangai2405/paychaos/internal/audit"
	"github.com/shangai2405/paychaos/internal/chaos"
	"github.com/shangai2405/paychaos/internal/mock"
)

type harness struct {
	mock     *mock.Server
	upstream *httptest.Server
	auditor  *audit.Auditor
	proxy    *httptest.Server
	logs     *syncBuffer
}

type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

func newHarness(t *testing.T, rules ...chaos.Rule) harness {
	t.Helper()
	return newHarnessWith(t, mock.New(), nil, rules...)
}

func newHarnessWith(t *testing.T, m *mock.Server, opParams []string, rules ...chaos.Rule) harness {
	t.Helper()
	up := httptest.NewServer(m)
	t.Cleanup(up.Close)
	u, _ := url.Parse(up.URL)
	cfg := chaos.Config{Seed: 1, Rules: rules, MutatingPaths: chaos.DefaultMutatingPaths}
	a := audit.New(cfg.MutatingPaths, 0).WithOperationID(opParams)
	logs := &syncBuffer{}
	px, err := New(Options{Upstream: u, Engine: chaos.NewEngine(cfg), Auditor: a, AllowedHosts: []string{u.Host},
		Logger: slog.New(slog.NewTextHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug}))})
	if err != nil {
		t.Fatal(err)
	}
	ps := httptest.NewServer(px)
	t.Cleanup(ps.Close)
	return harness{mock: m, upstream: up, auditor: a, proxy: ps, logs: logs}
}

type result struct {
	status  int
	body    map[string]any
	bodyErr error
}

// call sends one JSON POST (or a GET when body is nil and method is GET).
func call(t *testing.T, method, url, token, reqID string, body any) (result, error) {
	t.Helper()
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, url, rd)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	if reqID != "" {
		req.Header.Set("PayPal-Request-Id", reqID)
	}
	c := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{DisableKeepAlives: true}}
	resp, err := c.Do(req)
	if err != nil {
		return result{}, err
	}
	defer resp.Body.Close()
	r := result{status: resp.StatusCode}
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		r.bodyErr = err
		return r, nil
	}
	r.bodyErr = json.Unmarshal(raw, &r.body)
	return r, nil
}

func orderBody(invoice string) map[string]any {
	return map[string]any{
		"intent": "CAPTURE",
		"purchase_units": []any{map[string]any{
			"invoice_id": invoice,
			"amount":     map[string]any{"currency_code": "USD", "value": "50.00"},
		}},
		"payment_source": map[string]any{"paypal": map[string]any{}},
	}
}

func createOrder(t *testing.T, base, token, reqID string) (result, error) {
	return call(t, http.MethodPost, base+"/v2/checkout/orders", token, reqID, orderBody("INV-1"))
}

func rule(name, prefix string, f chaos.Fault) chaos.Rule {
	return chaos.Rule{Name: name, Match: chaos.Match{Method: "POST", PathPrefix: prefix}, Fault: f, Probability: 1, MaxHits: 1}
}

var dropFirstOrder = rule("drop", "/v2/checkout/orders", chaos.FaultDropAfterCommit)

func codes(fs []audit.Finding) map[string]audit.Severity {
	m := map[string]audit.Severity{}
	for _, f := range fs {
		m[f.Code] = f.Severity
	}
	return m
}

func finding(fs []audit.Finding, code string) *audit.Finding {
	for _, f := range fs {
		if f.Code == code {
			return &f
		}
	}
	return nil
}

func TestLiveHostsAreRefusedAtStartup(t *testing.T) {
	cfg := chaos.Config{Seed: 1}
	for _, raw := range []string{"https://api-m.paypal.com", "https://api.paypal.com", "http://api-m.sandbox.paypal.com", "https://example.com"} {
		u, _ := url.Parse(raw)
		_, err := New(Options{Upstream: u, Engine: chaos.NewEngine(cfg), Auditor: audit.New(nil, 0)})
		if !errors.Is(err, ErrHostNotAllowed) {
			t.Errorf("%s: want ErrHostNotAllowed, got %v", raw, err)
		}
	}
	for _, raw := range []string{"https://api-m.sandbox.paypal.com", "https://api.sandbox.paypal.com/"} {
		u, _ := url.Parse(raw)
		if _, err := New(Options{Upstream: u, Engine: chaos.NewEngine(cfg), Auditor: audit.New(nil, 0)}); err != nil {
			t.Errorf("%s refused: %v", raw, err)
		}
	}
}

// A client that retries a lost response without PayPal-Request-Id creates two
// orders upstream, and the auditor names both.
func TestNaiveRetryDuplicates(t *testing.T) {
	h := newHarness(t, dropFirstOrder)
	if _, err := createOrder(t, h.proxy.URL, "tok", ""); err == nil {
		t.Fatal("expected the first attempt to fail with a reset connection")
	}
	if r, err := createOrder(t, h.proxy.URL, "tok", ""); err != nil || r.status != 201 {
		t.Fatalf("retry: %+v %v", r, err)
	}
	if got := h.mock.Created("orders"); got != 2 {
		t.Fatalf("upstream created %d orders, want 2", got)
	}
	f := finding(h.auditor.Findings(), audit.CodeUnsafeRetry)
	if f == nil || f.Severity != audit.High || len(f.ObjectIDs) != 2 || f.ObjectIDs[0] == f.ObjectIDs[1] || f.Operation != "create_order" {
		t.Fatalf("want HIGH naming both orders, got %+v", h.auditor.Findings())
	}
	if f.Currency != "USD" || f.AmountMinor != 5000 {
		t.Fatalf("money at risk = %d %s, want 5000 USD", f.AmountMinor, f.Currency)
	}
}

// With a stable PayPal-Request-Id the retry gets the existing order back.
func TestSameRequestIDIsSafe(t *testing.T) {
	h := newHarness(t, dropFirstOrder)
	if _, err := createOrder(t, h.proxy.URL, "tok", "6f1c1e0a-3b7e-4b8f-9a42-1c2d3e4f5a6b"); err == nil {
		t.Fatal("expected the first attempt to fail")
	}
	r, err := createOrder(t, h.proxy.URL, "tok", "6f1c1e0a-3b7e-4b8f-9a42-1c2d3e4f5a6b")
	if err != nil || r.status != 201 {
		t.Fatalf("retry: %+v %v", r, err)
	}
	if h.mock.Created("orders") != 1 {
		t.Fatalf("created %d orders, want 1", h.mock.Created("orders"))
	}
	if fs := h.auditor.Findings(); len(fs) != 0 {
		t.Fatalf("unexpected findings %+v", fs)
	}
}

func TestRotatingRequestIDDuplicates(t *testing.T) {
	h := newHarness(t, dropFirstOrder)
	_, _ = createOrder(t, h.proxy.URL, "tok", "id-1")
	_, _ = createOrder(t, h.proxy.URL, "tok", "id-2")
	if h.mock.Created("orders") != 2 || codes(h.auditor.Findings())[audit.CodeUnsafeRetry] != audit.High {
		t.Fatalf("created=%d findings=%+v", h.mock.Created("orders"), h.auditor.Findings())
	}
}

// capturedOrder creates and captures an order directly on the mock, returning
// the order id and capture id.
func capturedOrder(t *testing.T, upstream string) (string, string) {
	t.Helper()
	r, err := createOrder(t, upstream, "tok", "")
	if err != nil || r.status != 201 {
		t.Fatalf("create: %+v %v", r, err)
	}
	id := r.body["id"].(string)
	c, err := call(t, http.MethodPost, upstream+"/v2/checkout/orders/"+id+"/capture", "tok", "", nil)
	if err != nil || c.status != 201 {
		t.Fatalf("capture: %+v %v", c, err)
	}
	b, _ := json.Marshal(c.body)
	return id, CreatedID(b)
}

// Two partial refunds of one capture both succeed without a request id, so a
// lost refund response retried naively refunds twice.
func TestNaiveRefundRetryRefundsTwice(t *testing.T) {
	h := newHarness(t, rule("drop-refund", "/v2/payments/captures", chaos.FaultDropAfterCommit))
	_, capID := capturedOrder(t, h.upstream.URL)
	refund := map[string]any{"amount": map[string]any{"currency_code": "USD", "value": "10.00"}}
	path := h.proxy.URL + "/v2/payments/captures/" + capID + "/refund"
	if _, err := call(t, http.MethodPost, path, "tok", "", refund); err == nil {
		t.Fatal("first refund should lose its response")
	}
	if r, err := call(t, http.MethodPost, path, "tok", "", refund); err != nil || r.status != 201 {
		t.Fatalf("retry: %+v %v", r, err)
	}
	if h.mock.Created("refunds") != 2 {
		t.Fatalf("created %d refunds, want 2", h.mock.Created("refunds"))
	}
	f := finding(h.auditor.Findings(), audit.CodeUnsafeRetry)
	if f == nil || f.Operation != "refund_capture" || !strings.Contains(f.Message, "duplicate refund") {
		t.Fatalf("want a duplicate-refund finding, got %+v", h.auditor.Findings())
	}
	if f.Currency != "USD" || f.AmountMinor != 1000 {
		t.Fatalf("money at risk = %d %s, want the refunded 1000 USD", f.AmountMinor, f.Currency)
	}
}

// An order capture carries no amount in its request; the amount at risk is
// read from the capture in the (lost) response.
func TestCaptureAmountComesFromResponse(t *testing.T) {
	h := newHarness(t, rule("drop-capture", "/v2/checkout/orders/", chaos.FaultDropAfterCommit))
	r, _ := createOrder(t, h.upstream.URL, "tok", "")
	id := r.body["id"].(string)
	if _, err := call(t, http.MethodPost, h.proxy.URL+"/v2/checkout/orders/"+id+"/capture", "tok", "", nil); err == nil {
		t.Fatal("capture should lose its response")
	}
	f := finding(h.auditor.Findings(), audit.CodeUnreconciled)
	if f == nil || f.Currency != "USD" || f.AmountMinor != 5000 {
		t.Fatalf("want 50.00 USD at risk on %s, got %+v", audit.CodeUnreconciled, h.auditor.Findings())
	}
	recs := h.auditor.Records()
	if len(recs) != 1 || recs[0].AmountMinor != 5000 || recs[0].Currency != "USD" {
		t.Fatalf("record amount: %+v", recs)
	}
}

// Capture response lost; a retry without the request id gets 422
// ORDER_ALREADY_CAPTURED. If the client never GETs the order, flag it.
func TestCaptureRetryAlreadyCaptured(t *testing.T) {
	for _, fetch := range []bool{false, true} {
		t.Run(fmt.Sprintf("fetch=%v", fetch), func(t *testing.T) {
			h := newHarness(t, rule("drop-capture", "/v2/checkout/orders/", chaos.FaultDropAfterCommit))
			r, _ := createOrder(t, h.upstream.URL, "tok", "")
			id := r.body["id"].(string)
			capURL := h.proxy.URL + "/v2/checkout/orders/" + id + "/capture"
			if _, err := call(t, http.MethodPost, capURL, "tok", "", nil); err == nil {
				t.Fatal("capture should lose its response")
			}
			r2, err := call(t, http.MethodPost, capURL, "tok", "", nil)
			if err != nil || r2.status != 422 {
				t.Fatalf("retry: %+v %v", r2, err)
			}
			if fetch {
				if g, err := call(t, http.MethodGet, h.proxy.URL+"/v2/checkout/orders/"+id, "tok", "", nil); err != nil || g.status != 200 || g.body["status"] != "COMPLETED" {
					t.Fatalf("get: %+v %v", g, err)
				}
			}
			fs := h.auditor.Findings()
			got := finding(fs, audit.CodeAlreadyCaptured)
			if fetch && got != nil {
				t.Fatalf("client fetched the order; got %+v", fs)
			}
			if !fetch && (got == nil || got.Severity != audit.Medium) {
				t.Fatalf("want %s, got %+v", audit.CodeAlreadyCaptured, fs)
			}
			if !fetch && (got.Currency != "USD" || got.AmountMinor != 5000) {
				t.Fatalf("already-captured finding should carry the captured 50.00 USD, got %+v", got)
			}
			if h.mock.Created("captures") != 1 {
				t.Fatal("PayPal blocks a second capture of one order")
			}
		})
	}
}

// A same-id capture retry returns the order's latest state, with the capture
// id inside it, and nothing is flagged.
func TestCaptureSameRequestIDReturnsLatestState(t *testing.T) {
	h := newHarness(t, rule("drop-capture", "/v2/checkout/orders/", chaos.FaultDropAfterCommit))
	r, _ := createOrder(t, h.upstream.URL, "tok", "")
	id := r.body["id"].(string)
	capURL := h.proxy.URL + "/v2/checkout/orders/" + id + "/capture"
	_, _ = call(t, http.MethodPost, capURL, "tok", "cap-"+id, nil)
	r2, err := call(t, http.MethodPost, capURL, "tok", "cap-"+id, nil)
	if err != nil || r2.status != 201 || r2.body["status"] != "COMPLETED" {
		t.Fatalf("retry: %+v %v", r2, err)
	}
	recs := h.auditor.Records()
	if len(recs) != 2 || recs[0].ObjectID == "" || recs[0].ObjectID != recs[1].ObjectID || recs[0].ObjectID == id {
		t.Fatalf("both attempts should name the same capture id (not the order id): %+v", recs)
	}
	if fs := h.auditor.Findings(); len(fs) != 0 {
		t.Fatalf("unexpected findings %+v", fs)
	}
}

func TestCreatedIDShapes(t *testing.T) {
	cases := map[string]string{
		`{"id":"ORDER","purchase_units":[{"payments":{"captures":[{"id":"CAP"}]}}]}`:        "CAP",
		`{"id":"ORDER","purchase_units":[{"payments":{"authorizations":[{"id":"AUTH"}]}}]}`: "AUTH",
		`{"id":"ORDER","purchase_units":[{"reference_id":"default"}]}`:                      "ORDER",
		`{"batch_header":{"payout_batch_id":"BATCH"}}`:                                      "BATCH",
		`{"id":"REFUND","status":"COMPLETED"}`:                                              "REFUND",
		`not json`:                                                                          "",
	}
	for body, want := range cases {
		if got := CreatedID([]byte(body)); got != want {
			t.Errorf("CreatedID(%s) = %q, want %q", body, got, want)
		}
	}
}

func getToken(t *testing.T, base, clientID, secret string) string {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, base+TokenPath, strings.NewReader("grant_type=client_credentials"))
	req.SetBasicAuth(clientID, secret)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var tok struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&tok); err != nil || tok.AccessToken == "" {
		t.Fatalf("token: %v %+v", err, tok)
	}
	return tok.AccessToken
}

// The token call passes through untouched and unaudited, and neither the
// client secret nor the access token appears in logs or records.
func TestTokenCallPassesThroughWithoutLeakingSecrets(t *testing.T) {
	always500 := chaos.Rule{Name: "everything", Fault: chaos.FaultError500, Probability: 1}
	h := newHarness(t, always500)
	tok := getToken(t, h.proxy.URL, "client-abc", "very-secret-value")
	if len(h.auditor.Records()) != 0 {
		t.Fatal("token call was audited")
	}
	_, _ = createOrder(t, h.proxy.URL, tok, "")
	recs, _ := json.Marshal(h.auditor.Records())
	finds, _ := json.Marshal(h.auditor.Findings())
	for _, secret := range []string{"very-secret-value", "client-abc", tok} {
		for name, hay := range map[string]string{"logs": h.logs.String(), "records": string(recs), "findings": string(finds)} {
			if strings.Contains(hay, secret) {
				t.Fatalf("%q leaked into %s", secret, name)
			}
		}
	}
}

// A token refresh between a lost response and the retry must not hide the
// duplicate: both tokens map back to the same client id.
func TestRetryAfterTokenRefreshStillGrouped(t *testing.T) {
	h := newHarness(t, dropFirstOrder)
	tok1 := getToken(t, h.proxy.URL, "client-abc", "s")
	_, _ = createOrder(t, h.proxy.URL, tok1, "")
	tok2 := getToken(t, h.proxy.URL, "client-abc", "s")
	if tok1 == tok2 {
		t.Fatal("mock issued the same token twice")
	}
	_, _ = createOrder(t, h.proxy.URL, tok2, "")
	if codes(h.auditor.Findings())[audit.CodeUnsafeRetry] != audit.High {
		t.Fatalf("duplicate hidden by token refresh: %+v", h.auditor.Findings())
	}
}

func TestTokenExpiredFault(t *testing.T) {
	expire := rule("expire", "/v2/checkout/orders", chaos.FaultTokenExpired)
	t.Run("reused", func(t *testing.T) {
		h := newHarness(t, expire)
		tok := getToken(t, h.proxy.URL, "c", "s")
		r, err := createOrder(t, h.proxy.URL, tok, "rid-1")
		if err != nil || r.status != 401 || r.body["error"] != "invalid_token" {
			t.Fatalf("want 401 invalid_token, got %+v %v", r, err)
		}
		if h.mock.Created("orders") != 0 {
			t.Fatal("401 must not reach upstream")
		}
		_, _ = createOrder(t, h.proxy.URL, tok, "rid-1")
		if codes(h.auditor.Findings())[audit.CodeTokenNotRefreshed] != audit.Medium {
			t.Fatalf("want %s, got %+v", audit.CodeTokenNotRefreshed, h.auditor.Findings())
		}
	})
	t.Run("refreshed", func(t *testing.T) {
		h := newHarness(t, expire)
		_, _ = createOrder(t, h.proxy.URL, getToken(t, h.proxy.URL, "c", "s"), "rid-1")
		_, _ = createOrder(t, h.proxy.URL, getToken(t, h.proxy.URL, "c", "s"), "rid-1")
		if fs := h.auditor.Findings(); len(fs) != 0 {
			t.Fatalf("refreshing client flagged: %+v", fs)
		}
	})
}

func TestInjectedErrorsDoNotReachUpstream(t *testing.T) {
	for _, f := range []chaos.Fault{chaos.FaultError500, chaos.FaultRateLimit} {
		h := newHarness(t, rule("e", "/v2/checkout/orders", f))
		r, err := createOrder(t, h.proxy.URL, "tok", "rid")
		if err != nil || (r.status != 500 && r.status != 429) {
			t.Fatalf("%s: %+v %v", f, r, err)
		}
		if r.body["name"] == nil || r.body["debug_id"] == nil {
			t.Fatalf("%s: not a PayPal-shaped error: %+v", f, r.body)
		}
		if h.mock.Created("orders") != 0 {
			t.Fatalf("%s reached upstream", f)
		}
	}
}

// A retry that changes another field and rotates its id is still the same
// operation when grouped by invoice id.
func TestOperationIDCatchesChangedRetry(t *testing.T) {
	h := newHarnessWith(t, mock.New(), []string{"purchase_units.0.invoice_id"}, dropFirstOrder)
	b1 := orderBody("INV-9")
	b1["purchase_units"].([]any)[0].(map[string]any)["custom_id"] = "attempt-1"
	b2 := orderBody("INV-9")
	b2["purchase_units"].([]any)[0].(map[string]any)["custom_id"] = "attempt-2"
	_, _ = call(t, http.MethodPost, h.proxy.URL+"/v2/checkout/orders", "tok", "a", b1)
	_, _ = call(t, http.MethodPost, h.proxy.URL+"/v2/checkout/orders", "tok", "b", b2)
	if codes(h.auditor.Findings())[audit.CodeUnsafeRetry] != audit.High {
		t.Fatalf("changed retry not caught: %+v", h.auditor.Findings())
	}
	// Without the operation id the bodies differ and nothing links them.
	h2 := newHarness(t, dropFirstOrder)
	_, _ = call(t, http.MethodPost, h2.proxy.URL+"/v2/checkout/orders", "tok", "a", b1)
	_, _ = call(t, http.MethodPost, h2.proxy.URL+"/v2/checkout/orders", "tok", "b", b2)
	if codes(h2.auditor.Findings())[audit.CodeUnsafeRetry] != "" {
		t.Fatal("expected body grouping to miss it")
	}
}

func TestRequestIDReusedWithDifferentBody(t *testing.T) {
	h := newHarness(t)
	_, _ = call(t, http.MethodPost, h.proxy.URL+"/v2/checkout/orders", "tok", "same", orderBody("INV-1"))
	r, _ := call(t, http.MethodPost, h.proxy.URL+"/v2/checkout/orders", "tok", "same", orderBody("INV-2"))
	if r.status != 201 || h.mock.Created("orders") != 1 {
		t.Fatalf("PayPal returns the first order for a reused id: %+v created=%d", r, h.mock.Created("orders"))
	}
	if codes(h.auditor.Findings())[audit.CodeRequestIDReusedNewBody] != audit.Medium {
		t.Fatalf("want reuse finding, got %+v", h.auditor.Findings())
	}
}

// PayPal: a 500 may have committed. A new id duplicates; the same id returns
// the resource's current state.
func TestError500AfterCommit(t *testing.T) {
	r500 := rule("500ac", "/v2/checkout/orders", chaos.FaultError500AfterCommit)
	h := newHarness(t, r500)
	r, _ := createOrder(t, h.proxy.URL, "tok", "k1")
	if r.status != 500 || h.mock.Created("orders") != 1 {
		t.Fatalf("status %d created %d", r.status, h.mock.Created("orders"))
	}
	r, _ = createOrder(t, h.proxy.URL, "tok", "k1")
	if r.status != 201 || h.mock.Created("orders") != 1 || len(h.auditor.Findings()) != 0 {
		t.Fatalf("same-id retry: %+v created=%d findings=%+v", r, h.mock.Created("orders"), h.auditor.Findings())
	}

	h2 := newHarness(t, r500)
	_, _ = createOrder(t, h2.proxy.URL, "tok", "k1")
	_, _ = createOrder(t, h2.proxy.URL, "tok", "k2")
	if h2.mock.Created("orders") != 2 || codes(h2.auditor.Findings())[audit.CodeUnsafeRetry] != audit.High {
		t.Fatalf("new-id retry: created=%d findings=%+v", h2.mock.Created("orders"), h2.auditor.Findings())
	}
}

// The upstream's own 500 after creating the order: unlike Stripe there is no
// cached 500. A same-id retry gets the order; a new-id retry is flagged.
func TestUpstream500ThenRetries(t *testing.T) {
	h := newHarnessWith(t, mock.NewWithOptions(mock.Options{ServerErrorEvery: 1}), nil)
	r, _ := createOrder(t, h.proxy.URL, "tok", "k1")
	if r.status != 500 {
		t.Fatalf("want upstream 500, got %d", r.status)
	}
	r, _ = createOrder(t, h.proxy.URL, "tok", "k1")
	if r.status != 201 || r.body["id"] == nil {
		t.Fatalf("same-id retry should get the order's current state, got %+v", r)
	}
	_, _ = createOrder(t, h.proxy.URL, "tok", "k2")
	if codes(h.auditor.Findings())[audit.CodeAmbiguousRetry] != "" {
		t.Fatalf("k2 followed a successful attempt; no ambiguity: %+v", h.auditor.Findings())
	}

	h2 := newHarnessWith(t, mock.NewWithOptions(mock.Options{ServerErrorEvery: 2}), nil)
	_, _ = createOrder(t, h2.proxy.URL, "tok", "x") // ok
	r, _ = createOrder(t, h2.proxy.URL, "tok", "y") // 500 after creating
	if r.status != 500 {
		t.Fatalf("want 500, got %d", r.status)
	}
	_, _ = createOrder(t, h2.proxy.URL, "tok", "z")
	if codes(h2.auditor.Findings())[audit.CodeAmbiguousRetry] != audit.Medium {
		t.Fatalf("want ambiguous-retry finding, got %+v", h2.auditor.Findings())
	}
}

// Reusing an id while the first request is still executing collides; switching
// to a new id afterwards is flagged.
func TestConflictThenNewID(t *testing.T) {
	h := newHarnessWith(t, mock.NewWithOptions(mock.Options{ExecDelay: 300 * time.Millisecond}), nil,
		chaos.Rule{Name: "hold", Match: chaos.Match{Method: "POST"}, Fault: chaos.FaultHoldResponse, Probability: 1, MaxHits: 1, DelayMS: 2000})
	go func() { _, _ = createOrder(t, h.proxy.URL, "tok", "k1") }()
	time.Sleep(100 * time.Millisecond)
	r, _ := createOrder(t, h.proxy.URL, "tok", "k1")
	if r.status != 409 {
		t.Fatalf("want 409 while the first is in flight, got %d", r.status)
	}
	_, _ = createOrder(t, h.proxy.URL, "tok", "k2")
	if codes(h.auditor.Findings())[audit.CodeAmbiguousRetry] != audit.Medium {
		t.Fatalf("want ambiguous-retry finding, got %+v", h.auditor.Findings())
	}
}

func TestHoldResponseClientGivesUp(t *testing.T) {
	h := newHarness(t, chaos.Rule{Name: "hold", Match: chaos.Match{Method: "POST"}, Fault: chaos.FaultHoldResponse, Probability: 1, MaxHits: 1, DelayMS: 1500})
	b, _ := json.Marshal(orderBody("INV-1"))
	req, _ := http.NewRequest(http.MethodPost, h.proxy.URL+"/v2/checkout/orders", bytes.NewReader(b))
	req.Header.Set("Authorization", "Bearer tok")
	req.Header.Set("Content-Type", "application/json")
	c := &http.Client{Timeout: 200 * time.Millisecond}
	if _, err := c.Do(req); err == nil {
		t.Fatal("client should time out")
	}
	time.Sleep(50 * time.Millisecond)
	_, _ = createOrder(t, h.proxy.URL, "tok", "")
	if codes(h.auditor.Findings())[audit.CodeUnsafeRetry] != audit.High {
		t.Fatalf("want HIGH, got %+v", h.auditor.Findings())
	}
}

func TestHoldResponseDelivered(t *testing.T) {
	h := newHarness(t, chaos.Rule{Name: "hold", Match: chaos.Match{Method: "POST"}, Fault: chaos.FaultHoldResponse, Probability: 1, MaxHits: 1, DelayMS: 100})
	if r, err := createOrder(t, h.proxy.URL, "tok", "a"); err != nil || r.status != 201 {
		t.Fatalf("%+v %v", r, err)
	}
	_, _ = createOrder(t, h.proxy.URL, "tok", "b")
	if codes(h.auditor.Findings())[audit.CodeUnsafeRetry] != "" || codes(h.auditor.Findings())[audit.CodeUnreconciled] != "" {
		t.Fatalf("delivered response blamed: %+v", h.auditor.Findings())
	}
}

var truncateFirst = rule("truncate", "/v2/checkout/orders", chaos.FaultTruncateAfterCommit)

func TestTruncatedResponse(t *testing.T) {
	t.Run("then naive retry", func(t *testing.T) {
		h := newHarness(t, truncateFirst)
		r, err := createOrder(t, h.proxy.URL, "tok", "")
		if err != nil || r.status != 201 || r.bodyErr == nil {
			t.Fatalf("want a 201 with an unreadable body, got %+v %v", r, err)
		}
		_, _ = createOrder(t, h.proxy.URL, "tok", "")
		if h.mock.Created("orders") != 2 || codes(h.auditor.Findings())[audit.CodeUnsafeRetry] != audit.High {
			t.Fatalf("created=%d %+v", h.mock.Created("orders"), h.auditor.Findings())
		}
	})
	t.Run("same id retry", func(t *testing.T) {
		h := newHarness(t, truncateFirst)
		_, _ = createOrder(t, h.proxy.URL, "tok", "k")
		r, _ := createOrder(t, h.proxy.URL, "tok", "k")
		if r.bodyErr != nil || h.mock.Created("orders") != 1 || len(h.auditor.Findings()) != 0 {
			t.Fatalf("%+v created=%d %+v", r, h.mock.Created("orders"), h.auditor.Findings())
		}
	})
	t.Run("never retried", func(t *testing.T) {
		h := newHarness(t, truncateFirst)
		_, _ = createOrder(t, h.proxy.URL, "tok", "k")
		fs := h.auditor.Findings()
		if len(fs) != 1 || fs[0].Code != audit.CodeTruncatedAccepted || fs[0].Severity != audit.Low {
			t.Fatalf("%+v", fs)
		}
	})
}

// A late retry after PayPal has forgotten the request id refunds again.
func TestExpiredRequestIDRefundsAgain(t *testing.T) {
	m := mock.NewWithOptions(mock.Options{RequestIDTTL: 50 * time.Millisecond})
	h := newHarnessWith(t, m, nil)
	_, capID := capturedOrder(t, h.upstream.URL)
	refund := map[string]any{"amount": map[string]any{"currency_code": "USD", "value": "5.00"}}
	path := h.proxy.URL + "/v2/payments/captures/" + capID + "/refund"
	_, _ = call(t, http.MethodPost, path, "tok", "refund-1", refund)
	_, _ = call(t, http.MethodPost, path, "tok", "refund-1", refund)
	if m.Created("refunds") != 1 {
		t.Fatalf("within the TTL the id protects the refund, got %d", m.Created("refunds"))
	}
	time.Sleep(80 * time.Millisecond)
	_, _ = call(t, http.MethodPost, path, "tok", "refund-1", refund)
	if m.Created("refunds") != 2 {
		t.Fatalf("after the TTL the id is forgotten, got %d refunds", m.Created("refunds"))
	}
}
