// Package audit watches the requests a client sends through the proxy and flags
// retry behaviour that would duplicate money movement in production.
//
// The rules follow PayPal's REST API idempotency model: a POST carries a
// PayPal-Request-Id header; a retry with the same id returns the latest state
// of the resource the first request created; a request without one is simply
// processed again.
package audit

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/shangai2405/paychaos/internal/chaos"
)

// RequestIDHeader is the header PayPal reads for idempotency on POST calls.
const RequestIDHeader = "PayPal-Request-Id"

// MaxRequestIDLen is PayPal's documented limit: 38 single-byte characters.
const MaxRequestIDLen = 38

// Severity of a finding.
type Severity string

const (
	High   Severity = "HIGH"
	Medium Severity = "MEDIUM"
	Low    Severity = "LOW"
)

// Finding codes.
const (
	CodeUnsafeRetry            = "UNSAFE_RETRY_AFTER_LOST_RESPONSE"
	CodeWouldDuplicate         = "UNSAFE_RETRY_FAILED_THIS_TIME"
	CodeUnreconciled           = "COMMITTED_BUT_REPORTED_AS_FAILED"
	CodeAmbiguousRetry         = "NEW_REQUEST_ID_AFTER_INDETERMINATE_ERROR"
	CodeMissingRequestID       = "MISSING_REQUEST_ID"
	CodeRequestIDReusedNewBody = "REQUEST_ID_REUSED_WITH_DIFFERENT_BODY"
	CodeRequestIDTooLong       = "REQUEST_ID_TOO_LONG"
	CodeNoBackoff              = "RETRY_WITHOUT_BACKOFF"
	CodeTruncatedAccepted      = "TRUNCATED_SUCCESS_NOT_RETRIED"
	CodeAlreadyCaptured        = "ALREADY_CAPTURED_NOT_RECONCILED"
	CodeTokenNotRefreshed      = "TOKEN_NOT_REFRESHED"
)

// AllCodes lists every finding code with its default severity, for docs and
// for the API's validation of ingested findings.
var AllCodes = map[string]Severity{
	CodeUnsafeRetry: High, CodeWouldDuplicate: Medium, CodeUnreconciled: Medium,
	CodeAmbiguousRetry: Medium, CodeMissingRequestID: Medium, CodeRequestIDReusedNewBody: Medium,
	CodeRequestIDTooLong: Low, CodeNoBackoff: Low, CodeTruncatedAccepted: Low,
	CodeAlreadyCaptured: Medium, CodeTokenNotRefreshed: Medium,
}

// PayPal error issues that mean "this was already done", returned with 422
// when an operation is repeated without the original PayPal-Request-Id.
// PayPal blocks the duplicate itself; the risk is that the client treats the
// error as a failure instead of fetching the resource.
var alreadyDoneIssues = map[string]bool{
	"ORDER_ALREADY_CAPTURED":         true,
	"ORDER_ALREADY_AUTHORIZED":       true,
	"AUTHORIZATION_ALREADY_CAPTURED": true,
}

// Finding is one problem the auditor detected.
type Finding struct {
	Code        string    `json:"code"`
	Severity    Severity  `json:"severity"`
	Message     string    `json:"message"`
	Path        string    `json:"path"`
	Operation   string    `json:"operation,omitempty"`
	Fingerprint string    `json:"fingerprint"`
	Requests    []int     `json:"requests"`
	ObjectIDs   []string  `json:"object_ids,omitempty"`
	At          time.Time `json:"at"`
}

// Record is one request seen by the proxy.
type Record struct {
	Seq         int         `json:"seq"`
	At          time.Time   `json:"at"`
	Done        time.Time   `json:"done"`
	Method      string      `json:"method"`
	Path        string      `json:"path"`
	Operation   string      `json:"operation,omitempty"`
	RequestID   string      `json:"request_id,omitempty"`
	Fingerprint string      `json:"fingerprint"`
	Rule        string      `json:"rule,omitempty"`
	Fault       chaos.Fault `json:"fault"`
	// UpstreamStatus is what the upstream answered, 0 if it was never asked.
	UpstreamStatus int `json:"upstream_status"`
	// Issue is the first PayPal error issue in the upstream's response body
	// (details[0].issue), e.g. ORDER_ALREADY_CAPTURED.
	Issue string `json:"issue,omitempty"`
	// ObjectID is the id of the resource the upstream created, when known.
	ObjectID string `json:"object_id,omitempty"`
	// ResponseDelivered is set once the client is known to have received the
	// upstream's response (used for hold_response, where it may give up first).
	ResponseDelivered bool `json:"response_delivered"`
	// Committed is true when the upstream processed the request successfully,
	// whether or not the client received the response.
	Committed bool `json:"committed"`

	// lostOriginal is the seq of an earlier committed attempt whose response
	// was lost and which this request retries without the original id. The
	// verdict waits for Complete, when we know whether this retry committed.
	lostOriginal int
	// tick orders this record against observed GETs.
	tick int
}

// Outcome is what happened to a request, reported by the proxy.
type Outcome struct {
	Rule           string
	Fault          chaos.Fault
	UpstreamStatus int
	Committed      bool
	ObjectID       string
	Issue          string
}

// Hooks are called, under the auditor's lock, as records complete and findings
// are raised. They must not block or call back into the auditor; the event
// streamer only enqueues.
type Hooks struct {
	OnRecord  func(Record)
	OnFinding func(Finding)
}

type rejectedToken struct {
	seq          int
	method, path string
}

// Auditor is safe for concurrent use.
type Auditor struct {
	mu         sync.Mutex
	mutating   []string
	requestID  []string // path prefixes where PayPal honours PayPal-Request-Id
	opParams   []string // body fields that identify one business operation
	minBackoff time.Duration
	now        func() time.Time
	hooks      Hooks

	records  map[int]*Record   // seq -> record, for operations still held in memory
	lastSeq  int               // highest seq handed out
	byFP     map[string][]int  // fingerprint -> seqs, in arrival order
	keyFP    map[string]keyUse // request id -> body hash first used with it
	resolved map[int]bool      // lost originals later recovered by a same-id retry
	findings []Finding
	seen     map[string]bool // de-duplicates repeated findings
	tick     int
	gets     map[string]getSeen // GET path -> its latest observation
	rejected map[string]rejectedToken

	// Settling bounds memory on long runs: an operation idle for longer than
	// settleAfter is judged (its end-of-run findings are decided now) and its
	// records are dropped. Zero keeps everything until the run ends.
	settleAfter    time.Duration
	sinceSettle    int
	settledCount   int
	settledFaults  map[chaos.Fault]int
	settledFinding []Finding
}

type keyUse struct {
	bodyHash string
	at       time.Time
}

type getSeen struct {
	tick int
	at   time.Time
}

// settleEvery is how many new requests pass between idle-operation sweeps,
// so the sweep's cost is spread thin.
const settleEvery = 256

// New creates an auditor.
func New(mutatingPaths []string, minBackoff time.Duration) *Auditor {
	return &Auditor{
		mutating:      mutatingPaths,
		requestID:     mutatingPaths,
		minBackoff:    minBackoff,
		now:           time.Now,
		records:       map[int]*Record{},
		byFP:          map[string][]int{},
		keyFP:         map[string]keyUse{},
		resolved:      map[int]bool{},
		seen:          map[string]bool{},
		gets:          map[string]getSeen{},
		rejected:      map[string]rejectedToken{},
		settledFaults: map[chaos.Fault]int{},
	}
}

// WithSettleAfter bounds the auditor's memory on long runs. An operation
// (all attempts sharing one fingerprint) with no activity for d is judged
// as if the run had ended for it, and its records are released; a retry
// arriving after that is treated as a new operation. d should comfortably
// exceed the longest retry schedule of the client under test. Zero (the
// default) keeps every record until the run ends.
func (a *Auditor) WithSettleAfter(d time.Duration) *Auditor {
	a.settleAfter = d
	return a
}

// WithRequestIDPaths sets the path prefixes where PayPal honours
// PayPal-Request-Id. MISSING_REQUEST_ID is raised only for these.
func (a *Auditor) WithRequestIDPaths(paths []string) *Auditor {
	if len(paths) > 0 {
		a.requestID = append([]string(nil), paths...)
	}
	return a
}

// WithHooks installs callbacks for streaming records and findings.
func (a *Auditor) WithHooks(h Hooks) *Auditor {
	a.hooks = h
	return a
}

// WithOperationID sets the body fields that identify one business operation:
// dotted JSON paths such as "purchase_units.0.invoice_id", or form parameter
// names. Requests carrying any of them are grouped by those values instead of
// by their whole body, so a retry that changes another field (an attempt
// counter, a timestamp) or rotates its request id is still recognised as the
// same operation.
func (a *Auditor) WithOperationID(params []string) *Auditor {
	a.opParams = append([]string(nil), params...)
	return a
}

// IsMutating reports whether the request is a money-moving write.
func (a *Auditor) IsMutating(method, path string) bool {
	return method == "POST" && hasPrefix(a.mutating, path)
}

func hasPrefix(prefixes []string, path string) bool {
	for _, p := range prefixes {
		if strings.HasPrefix(path, p) {
			return true
		}
	}
	return false
}

// Operation names the PayPal operation a request performs, or "" when the
// path is not one of the audited endpoints. Ids in the path are ignored, so
// every capture of every order is "capture_order".
func Operation(method, path string) string {
	if method != "POST" {
		return ""
	}
	p := strings.Split(strings.Trim(path, "/"), "/")
	switch {
	case len(p) == 3 && p[0] == "v2" && p[1] == "checkout" && p[2] == "orders":
		return "create_order"
	case len(p) == 5 && p[0] == "v2" && p[1] == "checkout" && p[2] == "orders" && p[4] == "capture":
		return "capture_order"
	case len(p) == 5 && p[0] == "v2" && p[1] == "checkout" && p[2] == "orders" && p[4] == "authorize":
		return "authorize_order"
	case len(p) == 5 && p[0] == "v2" && p[1] == "payments" && p[2] == "authorizations" && p[4] == "capture":
		return "capture_authorization"
	case len(p) == 5 && p[0] == "v2" && p[1] == "payments" && p[2] == "captures" && p[4] == "refund":
		return "refund_capture"
	case len(p) == 3 && p[0] == "v1" && p[1] == "payments" && p[2] == "payouts":
		return "create_payout"
	}
	return ""
}

func isJSON(contentType string) bool {
	ct := strings.ToLower(contentType)
	return strings.HasPrefix(ct, "application/json") || strings.Contains(ct, "+json")
}

func isForm(contentType string) bool {
	return contentType == "" || strings.HasPrefix(strings.ToLower(contentType), "application/x-www-form-urlencoded")
}

// canonicalJSON re-encodes a JSON document with sorted object keys and no
// insignificant whitespace, keeping numbers exactly as written. It returns
// false when body is not valid JSON.
func canonicalJSON(body []byte) ([]byte, bool) {
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, false
	}
	if dec.More() {
		return nil, false
	}
	out, err := json.Marshal(v) // map keys are emitted sorted
	if err != nil {
		return nil, false
	}
	return out, true
}

// Fingerprint identifies "the same logical request": same account, method,
// path and body. JSON bodies are canonicalised (key order and whitespace do
// not matter); form bodies are sorted by parameter. account is an opaque
// identifier and is hashed again here, so a raw credential never ends up in a
// fingerprint even if a caller passes one.
func Fingerprint(account, method, path, contentType string, body []byte) string {
	canon := string(body)
	switch {
	case isJSON(contentType) || (contentType == "" && looksJSON(body)):
		if c, ok := canonicalJSON(body); ok {
			canon = string(c)
		}
	case isForm(contentType):
		if v, err := url.ParseQuery(string(body)); err == nil {
			canon = v.Encode() // Encode sorts by key
		}
	}
	h := sha256.Sum256([]byte(HashSecret(account) + "|" + method + "|" + path + "|" + canon))
	return hex.EncodeToString(h[:6])
}

func looksJSON(body []byte) bool {
	t := bytes.TrimSpace(body)
	return len(t) > 0 && (t[0] == '{' || t[0] == '[')
}

// HashSecret returns a short, non-reversible label for a credential, used to
// group requests by account without storing the credential.
func HashSecret(k string) string {
	h := sha256.Sum256([]byte(k))
	return hex.EncodeToString(h[:4])
}

// lookupJSON follows a dotted path ("purchase_units.0.invoice_id") through a
// decoded JSON value and returns the leaf as a string.
func lookupJSON(v any, path string) (string, bool) {
	for _, part := range strings.Split(path, ".") {
		switch node := v.(type) {
		case map[string]any:
			next, ok := node[part]
			if !ok {
				return "", false
			}
			v = next
		case []any:
			i, err := strconv.Atoi(part)
			if err != nil || i < 0 || i >= len(node) {
				return "", false
			}
			v = node[i]
		default:
			return "", false
		}
	}
	switch leaf := v.(type) {
	case string:
		return leaf, leaf != ""
	case json.Number:
		return leaf.String(), true
	case bool:
		return strconv.FormatBool(leaf), true
	case nil:
		return "", false
	default:
		b, _ := json.Marshal(leaf)
		return string(b), true
	}
}

// OperationKey returns a fingerprint built only from the operation-id fields,
// and false when the body carries none of them.
func OperationKey(account, method, path, contentType string, body []byte, opParams []string) (string, bool) {
	if len(opParams) == 0 {
		return "", false
	}
	op := url.Values{}
	switch {
	case isJSON(contentType) || (contentType == "" && looksJSON(body)):
		dec := json.NewDecoder(bytes.NewReader(body))
		dec.UseNumber()
		var v any
		if dec.Decode(&v) != nil {
			return "", false
		}
		for _, p := range opParams {
			if x, ok := lookupJSON(v, p); ok {
				op.Set(p, x)
			}
		}
	case isForm(contentType):
		v, err := url.ParseQuery(string(body))
		if err != nil {
			return "", false
		}
		for _, p := range opParams {
			if x := v.Get(p); x != "" {
				op.Set(p, x)
			}
		}
	default:
		return "", false
	}
	if len(op) == 0 {
		return "", false
	}
	h := sha256.Sum256([]byte(HashSecret(account) + "|" + method + "|" + path + "|op|" + op.Encode()))
	return "op-" + hex.EncodeToString(h[:6]), true
}

// BeginRequest fingerprints a raw request and records it (see Begin). The
// operation key, when configured and present, groups retries; the exact body
// hash is still used to detect a request id reused with a different body.
func (a *Auditor) BeginRequest(account, method, path, contentType, requestID string, body []byte) int {
	bodyHash := Fingerprint(account, method, path, contentType, body)
	fp := bodyHash
	if k, ok := OperationKey(account, method, path, contentType, body, a.opParams); ok {
		fp = k
	}
	return a.begin(method, path, requestID, fp, bodyHash)
}

// Begin records an arriving request identified by fp, runs the checks that
// depend on earlier attempts, and returns a sequence number for Complete.
func (a *Auditor) Begin(method, path, requestID, fp string) int {
	return a.begin(method, path, requestID, fp, fp)
}

func (a *Auditor) begin(method, path, reqID, fp, bodyHash string) int {
	a.mu.Lock()
	defer a.mu.Unlock()

	now := a.now()
	a.tick++
	a.lastSeq++
	seq := a.lastSeq
	op := Operation(method, path)
	rec := Record{Seq: seq, At: now, Method: method, Path: path, Operation: op, RequestID: reqID, Fingerprint: fp, tick: a.tick}

	switch {
	case reqID == "" && hasPrefix(a.requestID, path):
		a.add(Finding{
			Code: CodeMissingRequestID, Severity: Medium, Path: path, Operation: op, Fingerprint: fp, Requests: []int{seq}, At: now,
			Message: fmt.Sprintf("POST %s sent without a %s header; PayPal processes a repeated request again, so any retry of it can create a duplicate", path, RequestIDHeader),
		}, CodeMissingRequestID+opOrPath(op, path))
	case reqID != "":
		if len(reqID) > MaxRequestIDLen {
			a.add(Finding{
				Code: CodeRequestIDTooLong, Severity: Low, Path: path, Operation: op, Fingerprint: fp, Requests: []int{seq}, At: now,
				Message: fmt.Sprintf("%s is %d characters; PayPal limits it to %d single-byte characters and recommends a UUID (36)", RequestIDHeader, len(reqID), MaxRequestIDLen),
			}, CodeRequestIDTooLong+opOrPath(op, path))
		}
		if prev, ok := a.keyFP[reqID]; ok && prev.bodyHash != bodyHash {
			a.add(Finding{
				Code: CodeRequestIDReusedNewBody, Severity: Medium, Path: path, Operation: op, Fingerprint: fp, Requests: []int{seq}, At: now,
				Message: fmt.Sprintf("%s reused with a different body. PayPal answers a repeated id with the latest state of the first request's resource, so this request's own changes are silently ignored. Use one id per logical operation", RequestIDHeader),
			}, CodeRequestIDReusedNewBody+reqID)
		} else if !ok {
			a.keyFP[reqID] = keyUse{bodyHash: bodyHash, at: now}
		}
	}

	if prev, ok := a.lastWithFP(fp); ok {
		sameID := reqID != "" && reqID == prev.RequestID
		if what := indeterminate(prev); what != "" && !sameID && !a.hasLostOriginal(fp, reqID) {
			a.add(Finding{
				Code: CodeAmbiguousRetry, Severity: Medium, Path: path, Operation: op, Fingerprint: fp, Requests: []int{prev.Seq, seq}, At: now,
				Message: fmt.Sprintf("request #%d ended with %s and was retried as #%d with %s. That outcome is indeterminate: retry with the same %s, or look the resource up first, because a new id can start a second operation",
					prev.Seq, what, seq, idDesc(reqID, prev.RequestID), RequestIDHeader),
			}, fmt.Sprintf("%s-%d", CodeAmbiguousRetry, prev.Seq))
		}
		if isRetryable(prev.Fault) && !prev.Done.IsZero() && a.minBackoff > 0 {
			if gap := now.Sub(prev.Done); gap < a.minBackoff {
				a.add(Finding{
					Code: CodeNoBackoff, Severity: Low, Path: path, Operation: op, Fingerprint: fp, Requests: []int{prev.Seq, seq}, At: now,
					Message: fmt.Sprintf("retried %v after a %s; expected at least %v of (ideally exponential, jittered) backoff",
						gap.Round(time.Millisecond), prev.Fault, a.minBackoff),
				}, fmt.Sprintf("%s-%d", CodeNoBackoff, prev.Seq))
			}
		}
	}

	if orig, ok := a.lostOriginalFor(fp); ok && (reqID == "" || reqID != orig.RequestID) {
		rec.lostOriginal = orig.Seq
	}

	a.records[seq] = &rec
	a.byFP[fp] = append(a.byFP[fp], seq)
	if a.settleAfter > 0 {
		if a.sinceSettle++; a.sinceSettle >= settleEvery {
			a.sinceSettle = 0
			a.settle(now)
		}
	}
	return seq
}

// settle judges and releases every operation idle since now-settleAfter.
// Called with the lock held.
func (a *Auditor) settle(now time.Time) {
	cutoff := now.Add(-a.settleAfter)
	for fp, seqs := range a.byFP {
		group := make([]*Record, 0, len(seqs))
		idle := true
		for _, s := range seqs {
			r := a.records[s]
			if r.Done.IsZero() || r.Done.After(cutoff) || r.At.After(cutoff) {
				idle = false
				break
			}
			group = append(group, r)
		}
		if !idle {
			continue
		}
		a.settledFinding = append(a.settledFinding, a.unreconciledIn(group)...)
		a.settledFinding = append(a.settledFinding, a.alreadyDoneIn(group)...)
		for _, r := range group {
			if r.Fault != "" && r.Fault != chaos.FaultNone {
				a.settledFaults[r.Fault]++
			}
			delete(a.records, r.Seq)
			delete(a.resolved, r.Seq)
		}
		a.settledCount += len(group)
		delete(a.byFP, fp)
	}
	for k, v := range a.keyFP {
		if v.at.Before(cutoff) {
			delete(a.keyFP, k)
		}
	}
	for k, v := range a.gets {
		if v.at.Before(cutoff) {
			delete(a.gets, k)
		}
	}
}

// Settled reports how many requests were judged and released early, and
// the faults those requests had, so totals stay right after settling.
func (a *Auditor) Settled() (int, map[chaos.Fault]int) {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := make(map[chaos.Fault]int, len(a.settledFaults))
	for k, v := range a.settledFaults {
		out[k] = v
	}
	return a.settledCount, out
}

// Held reports how many request records are in memory now.
func (a *Auditor) Held() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return len(a.records)
}

func opOrPath(op, path string) string {
	if op != "" {
		return op
	}
	return path
}

// Observe notes a request that is not audited, such as GET
// /v2/checkout/orders/{id}. It is how the auditor knows a client looked an
// order up after PayPal said it was already captured.
func (a *Auditor) Observe(method, path string) {
	if method != "GET" {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	a.tick++
	a.gets[strings.TrimSuffix(path, "/")] = getSeen{tick: a.tick, at: a.now()}
}

// TokenUsed is called for every request that carries a bearer token, before
// any fault is decided. tokenLabel is HashSecret(token). If that token was
// rejected with an injected 401 earlier, the client kept using it instead of
// fetching a new one.
func (a *Auditor) TokenUsed(tokenLabel, method, path string, seq int) {
	if tokenLabel == "" {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	rej, ok := a.rejected[tokenLabel]
	if !ok {
		return
	}
	reqs := []int{}
	if rej.seq > 0 {
		reqs = append(reqs, rej.seq)
	}
	if seq > 0 {
		reqs = append(reqs, seq)
	}
	a.add(Finding{
		Code: CodeTokenNotRefreshed, Severity: Medium, Path: path, Operation: Operation(method, path), Requests: reqs, At: a.now(),
		Message: fmt.Sprintf("%s %s was rejected with 401 invalid_token, and the client then sent %s %s with the same access token. Fetch a new token from /v1/oauth2/token on a 401 before retrying",
			rej.method, rej.path, method, path),
	}, CodeTokenNotRefreshed+tokenLabel)
}

// TokenRejected records that the proxy answered a request using tokenLabel
// with an injected 401. seq is the audited sequence number, or 0.
func (a *Auditor) TokenRejected(tokenLabel, method, path string, seq int) {
	if tokenLabel == "" {
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if _, ok := a.rejected[tokenLabel]; !ok {
		a.rejected[tokenLabel] = rejectedToken{seq: seq, method: method, path: path}
	}
}

// lostOriginalFor finds the most recent attempt for fp that committed upstream
// but whose response never reached the client, and that no same-id retry has
// recovered yet. Looking past the latest attempt matters: a retry chain of
// "lost response -> 429 -> retry" must still be traced back to the lost one.
func (a *Auditor) lostOriginalFor(fp string) (Record, bool) {
	idx := a.byFP[fp]
	for i := len(idx) - 1; i >= 0; i-- {
		r := *a.records[idx[i]]
		if r.Committed && lostResponse(r) && !a.resolved[r.Seq] {
			return r, true
		}
	}
	return Record{}, false
}

func (a *Auditor) hasLostOriginal(fp, reqID string) bool {
	orig, ok := a.lostOriginalFor(fp)
	return ok && (reqID == "" || reqID != orig.RequestID)
}

// lostResponse reports whether a committed attempt's result never reached the
// client: the connection was reset, the body was cut short, the client was
// told 500, or the response was held until after the client gave up.
func lostResponse(r Record) bool {
	switch r.Fault {
	case chaos.FaultDropAfterCommit, chaos.FaultError500AfterCommit, chaos.FaultTruncateAfterCommit:
		return true
	case chaos.FaultHoldResponse:
		return !r.ResponseDelivered
	}
	return false
}

// indeterminate describes an outcome after which a request may or may not have
// taken effect, or "" if the outcome was definite. Rate limits (429) and
// rejected tokens (401) are definite: nothing was executed.
func indeterminate(r Record) string {
	switch {
	case r.Fault == chaos.FaultTimeoutBeforeForward:
		return "a timeout"
	case r.Fault == chaos.FaultError500:
		return "a 500 error"
	case r.UpstreamStatus == 409:
		return "a 409 conflict"
	case r.UpstreamStatus >= 500:
		return fmt.Sprintf("a %d error", r.UpstreamStatus)
	}
	return ""
}

// MarkDelivered records that the client received the response to seq.
func (a *Auditor) MarkDelivered(seq int) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if r, ok := a.records[seq]; ok {
		r.ResponseDelivered = true
		if a.hooks.OnRecord != nil {
			a.hooks.OnRecord(*r)
		}
	}
}

// Complete stores the outcome of a request started with Begin.
// objectID is the id of the resource the upstream created ("" if unknown).
func (a *Auditor) Complete(seq int, rule string, fault chaos.Fault, upstreamStatus int, committed bool, objectID string) {
	a.CompleteWith(seq, Outcome{Rule: rule, Fault: fault, UpstreamStatus: upstreamStatus, Committed: committed, ObjectID: objectID})
}

// CompleteWith stores the outcome of a request started with Begin.
func (a *Auditor) CompleteWith(seq int, o Outcome) {
	a.mu.Lock()
	defer a.mu.Unlock()
	r, ok := a.records[seq]
	if !ok {
		return
	}
	r.Done = a.now()
	r.Rule = o.Rule
	r.Fault = o.Fault
	r.UpstreamStatus = o.UpstreamStatus
	r.Committed = o.Committed
	r.ObjectID = o.ObjectID
	r.Issue = o.Issue
	defer func() {
		if a.hooks.OnRecord != nil {
			a.hooks.OnRecord(*r)
		}
	}()

	if r.lostOriginal == 0 {
		// A same-id retry that commits recovers any lost original it matches.
		if o.Committed && r.RequestID != "" {
			if orig, ok := a.lostOriginalFor(r.Fingerprint); ok && orig.Seq != r.Seq && orig.RequestID == r.RequestID {
				a.resolved[orig.Seq] = true
			}
		}
		return
	}
	origRec, ok := a.records[r.lostOriginal]
	if !ok {
		return // cannot happen: a group is never settled while an attempt is pending
	}
	orig := *origRec
	ids := nonEmpty(orig.ObjectID, r.ObjectID)
	if o.Committed {
		created := "a second resource"
		if len(ids) == 2 {
			created = fmt.Sprintf("%s and %s were both created", ids[0], ids[1])
		}
		a.add(Finding{
			Code: CodeUnsafeRetry, Severity: High, Path: r.Path, Operation: r.Operation, Fingerprint: r.Fingerprint,
			Requests: []int{orig.Seq, r.Seq}, ObjectIDs: ids, At: r.Done,
			Message: fmt.Sprintf("request #%d succeeded upstream but its response was lost; retry #%d used %s and also succeeded, so %s for one operation (duplicate %s)",
				orig.Seq, r.Seq, idDesc(r.RequestID, orig.RequestID), created, duplicateWhat(r.Operation)),
		}, fmt.Sprintf("%s-%d", CodeUnsafeRetry, orig.Seq))
		// One duplicate has now happened; later retries are judged afresh.
		a.resolved[orig.Seq] = true
		return
	}
	if alreadyDoneIssues[o.Issue] {
		// PayPal itself refused the duplicate. Whether the client recovered
		// is decided at report time by looking for a GET of the resource.
		return
	}
	a.add(Finding{
		Code: CodeWouldDuplicate, Severity: Medium, Path: r.Path, Operation: r.Operation, Fingerprint: r.Fingerprint,
		Requests: []int{orig.Seq, r.Seq}, ObjectIDs: ids, At: r.Done,
		Message: fmt.Sprintf("request #%d succeeded upstream but its response was lost; retry #%d used %s. It failed this time (status %d), but had it succeeded it would have created a duplicate",
			orig.Seq, r.Seq, idDesc(r.RequestID, orig.RequestID), o.UpstreamStatus),
	}, fmt.Sprintf("%s-%d-%d", CodeWouldDuplicate, orig.Seq, r.Seq))
}

func duplicateWhat(op string) string {
	switch op {
	case "refund_capture":
		return "refund"
	case "create_payout":
		return "payout"
	case "capture_order", "capture_authorization":
		return "capture"
	case "authorize_order":
		return "authorization"
	case "create_order":
		return "order"
	}
	return "payment"
}

func nonEmpty(xs ...string) []string {
	var out []string
	for _, x := range xs {
		if x != "" {
			out = append(out, x)
		}
	}
	return out
}

func (a *Auditor) lastWithFP(fp string) (Record, bool) {
	idx := a.byFP[fp]
	if len(idx) == 0 {
		return Record{}, false
	}
	return *a.records[idx[len(idx)-1]], true
}

func (a *Auditor) add(f Finding, dedupeKey string) {
	if a.seen[dedupeKey] {
		return
	}
	a.seen[dedupeKey] = true
	a.findings = append(a.findings, f)
	if a.hooks.OnFinding != nil {
		a.hooks.OnFinding(f)
	}
}

func isRetryable(f chaos.Fault) bool {
	return f == chaos.FaultError500 || f == chaos.FaultRateLimit
}

func idDesc(now, prev string) string {
	switch {
	case now == "" && prev == "":
		return "no " + RequestIDHeader + " on either attempt"
	case now == "":
		return "no " + RequestIDHeader
	default:
		return "a different " + RequestIDHeader + " than the original"
	}
}

// resourcePath returns the GET path that reads the resource an "already done"
// error refers to: the order for an order capture or authorization, the
// authorization for an authorization capture.
func resourcePath(path string) string {
	p := strings.Split(strings.Trim(path, "/"), "/")
	if len(p) == 5 {
		return "/" + strings.Join(p[:4], "/")
	}
	return ""
}

// alreadyDone lists 422 "already captured/authorized" answers the client never
// followed with a GET of the resource. PayPal's advice is to GET the order and
// read the capture id from it; a client that doesn't has a captured payment it
// believes failed.
func (a *Auditor) alreadyDoneIn(recs []*Record) []Finding {
	var out []Finding
	for _, r := range recs {
		if !alreadyDoneIssues[r.Issue] {
			continue
		}
		res := resourcePath(r.Path)
		if res != "" && a.gets[res].tick > r.tick {
			continue
		}
		reqs := []int{r.Seq}
		lost := ""
		if r.lostOriginal != 0 {
			reqs = []int{r.lostOriginal, r.Seq}
			lost = fmt.Sprintf("request #%d was performed upstream but its response was lost; ", r.lostOriginal)
		}
		out = append(out, Finding{
			Code: CodeAlreadyCaptured, Severity: Medium, Path: r.Path, Operation: r.Operation, Fingerprint: r.Fingerprint,
			Requests: reqs, At: r.Done,
			Message: fmt.Sprintf("%sretry #%d got 422 %s and the client never fetched %s to read the result. PayPal blocked the duplicate, but the client likely recorded a failure for a payment that succeeded",
				lost, r.Seq, r.Issue, nonBlank(res, "the resource")),
		})
	}
	return out
}

func nonBlank(s, def string) string {
	if s == "" {
		return def
	}
	return "GET " + s
}

// unreconciled lists committed attempts whose response the client never got
// and that were never retried: the client believes the operation failed, but
// the upstream performed it. Computed at report time because a later retry
// would change the verdict.
func (a *Auditor) unreconciledIn(recs []*Record) []Finding {
	var out []Finding
	for _, r := range recs {
		if !r.Committed || !lostResponse(*r) || a.resolved[r.Seq] {
			continue
		}
		idx := a.byFP[r.Fingerprint]
		if idx[len(idx)-1] != r.Seq {
			continue // something retried it; judged elsewhere
		}
		if res := resourcePath(r.Path); res != "" && a.gets[res].tick > r.tick {
			continue // the client looked the resource up afterwards
		}
		if r.Fault == chaos.FaultTruncateAfterCommit {
			// The client did get a 2xx status, so it may well have treated
			// the request as a success. What it cannot have is the body.
			out = append(out, Finding{
				Code: CodeTruncatedAccepted, Severity: Low, Path: r.Path, Operation: r.Operation, Fingerprint: r.Fingerprint,
				Requests: []int{r.Seq}, ObjectIDs: nonEmpty(r.ObjectID), At: r.Done,
				Message: fmt.Sprintf("request #%d was performed upstream%s and answered with status %d, but the body was cut short and the client never retried. If it reads the created resource from the response, it has no record of it; if it treats an unreadable body as a failure, it recorded a failure for an operation that succeeded",
					r.Seq, objSuffix(r.ObjectID), r.UpstreamStatus),
			})
			continue
		}
		out = append(out, Finding{
			Code: CodeUnreconciled, Severity: Medium, Path: r.Path, Operation: r.Operation, Fingerprint: r.Fingerprint,
			Requests: []int{r.Seq}, ObjectIDs: nonEmpty(r.ObjectID), At: r.Done,
			Message: fmt.Sprintf("request #%d was performed upstream%s, but the client got %s and never retried; it likely recorded a failure for an operation that succeeded. Reconcile via webhooks or by retrieving the resource",
				r.Seq, objSuffix(r.ObjectID), lostHow(r.Fault)),
		})
	}
	return out
}

func objSuffix(id string) string {
	if id == "" {
		return ""
	}
	return " (" + id + ")"
}

func lostHow(f chaos.Fault) string {
	switch f {
	case chaos.FaultError500AfterCommit:
		return "a 500 error"
	case chaos.FaultHoldResponse:
		return "no response before giving up"
	}
	return "a reset connection"
}

// Findings returns findings sorted by severity, then time, then code, so two
// runs with the same seed and request order list them identically.
func (a *Auditor) Findings() []Finding {
	a.mu.Lock()
	defer a.mu.Unlock()
	held := a.held()
	out := append([]Finding(nil), a.findings...)
	out = append(out, a.settledFinding...)
	out = append(out, a.unreconciledIn(held)...)
	out = append(out, a.alreadyDoneIn(held)...)
	rank := map[Severity]int{High: 0, Medium: 1, Low: 2}
	sort.SliceStable(out, func(i, j int) bool {
		if rank[out[i].Severity] != rank[out[j].Severity] {
			return rank[out[i].Severity] < rank[out[j].Severity]
		}
		if !out[i].At.Equal(out[j].At) {
			return out[i].At.Before(out[j].At)
		}
		return out[i].Code < out[j].Code
	})
	return out
}

// held returns the records in memory in seq order. Called with the lock held.
func (a *Auditor) held() []*Record {
	out := make([]*Record, 0, len(a.records))
	for _, r := range a.records {
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Seq < out[j].Seq })
	return out
}

// Records returns a copy of every audited request still held in memory, in
// order. Without settling that is every request of the run.
func (a *Auditor) Records() []Record {
	a.mu.Lock()
	defer a.mu.Unlock()
	h := a.held()
	out := make([]Record, len(h))
	for i, r := range h {
		out[i] = *r
	}
	return out
}
