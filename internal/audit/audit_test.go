package audit

import (
	"testing"
	"time"

	"github.com/shangai2405/paychaos/internal/chaos"
)

func newClocked(minBackoff time.Duration) (*Auditor, *time.Time) {
	a := New(chaos.DefaultMutatingPaths, minBackoff)
	now := time.Unix(1_700_000_000, 0)
	a.now = func() time.Time { return now }
	return a, &now
}

func has(fs []Finding, code string) bool {
	for _, f := range fs {
		if f.Code == code {
			return true
		}
	}
	return false
}

func TestFingerprintIgnoresParamOrder(t *testing.T) {
	ct := "application/x-www-form-urlencoded"
	a := Fingerprint("sk_test_1", "POST", "/v2/checkout/orders", ct, []byte("amount=100&currency=inr"))
	b := Fingerprint("sk_test_1", "POST", "/v2/checkout/orders", ct, []byte("currency=inr&amount=100"))
	c := Fingerprint("sk_test_2", "POST", "/v2/checkout/orders", ct, []byte("amount=100&currency=inr"))
	if a != b {
		t.Fatal("param order changed the fingerprint")
	}
	if a == c {
		t.Fatal("different accounts share a fingerprint")
	}
}

func TestKeyReusedWithDifferentBody(t *testing.T) {
	a, _ := newClocked(0)
	a.Complete(a.Begin("POST", "/v2/payments/captures/X/refund", "k1", "fpA"), "", chaos.FaultNone, 200, true, "")
	a.Begin("POST", "/v2/payments/captures/X/refund", "k1", "fpB")
	if !has(a.Findings(), CodeRequestIDReusedNewBody) {
		t.Fatal("expected key-reuse finding")
	}
}

func TestNoBackoff(t *testing.T) {
	a, now := newClocked(200 * time.Millisecond)
	a.Complete(a.Begin("POST", "/v2/checkout/orders", "k", "fp"), "r", chaos.FaultRateLimit, 0, false, "")
	*now = now.Add(20 * time.Millisecond)
	a.Begin("POST", "/v2/checkout/orders", "k", "fp")
	if !has(a.Findings(), CodeNoBackoff) {
		t.Fatal("expected no-backoff finding")
	}

	b, now2 := newClocked(200 * time.Millisecond)
	b.Complete(b.Begin("POST", "/v2/checkout/orders", "k", "fp"), "r", chaos.FaultRateLimit, 0, false, "")
	*now2 = now2.Add(time.Second)
	b.Begin("POST", "/v2/checkout/orders", "k", "fp")
	if has(b.Findings(), CodeNoBackoff) {
		t.Fatal("1s backoff should not be flagged")
	}
}

func TestAmbiguousTimeoutRetry(t *testing.T) {
	a, _ := newClocked(0)
	a.Complete(a.Begin("POST", "/v1/payouts", "", "fp"), "t", chaos.FaultTimeoutBeforeForward, 0, false, "")
	a.Begin("POST", "/v1/payouts", "", "fp")
	if !has(a.Findings(), CodeAmbiguousRetry) {
		t.Fatal("expected ambiguous timeout finding")
	}
}

func TestOnlyMutatingPostsAudited(t *testing.T) {
	a := New(chaos.DefaultMutatingPaths, 0)
	if a.IsMutating("GET", "/v2/checkout/orders") || a.IsMutating("POST", "/v1/balance") {
		t.Fatal("non-mutating request classified as mutating")
	}
	if !a.IsMutating("POST", "/v2/checkout/orders/pi_1/confirm") {
		t.Fatal("confirm should be audited")
	}
}

func severityOf(fs []Finding, code string) Severity {
	for _, f := range fs {
		if f.Code == code {
			return f.Severity
		}
	}
	return ""
}

// A retry that itself fails cannot have created a duplicate, so it must not be
// reported as one; it is still worth a MEDIUM warning.
func TestFailedUnsafeRetryIsMediumNotHigh(t *testing.T) {
	a, _ := newClocked(0)
	a.Complete(a.Begin("POST", "/v2/checkout/orders", "", "fp"), "drop", chaos.FaultDropAfterCommit, 200, true, "pi_A")
	a.Complete(a.Begin("POST", "/v2/checkout/orders", "", "fp"), "429", chaos.FaultRateLimit, 0, false, "")
	fs := a.Findings()
	if has(fs, CodeUnsafeRetry) {
		t.Fatalf("failed retry reported as a duplicate: %+v", fs)
	}
	if severityOf(fs, CodeWouldDuplicate) != Medium {
		t.Fatalf("want MEDIUM %s, got %+v", CodeWouldDuplicate, fs)
	}
}

// lost response -> retry hits 429 -> retry succeeds: the duplicate must be
// traced back to the lost original, not to the 429 in between.
func TestRetryChainTracedToLostOriginal(t *testing.T) {
	a, _ := newClocked(0)
	a.Complete(a.Begin("POST", "/v2/checkout/orders", "", "fp"), "drop", chaos.FaultDropAfterCommit, 200, true, "pi_A")
	a.Complete(a.Begin("POST", "/v2/checkout/orders", "", "fp"), "429", chaos.FaultRateLimit, 0, false, "")
	a.Complete(a.Begin("POST", "/v2/checkout/orders", "", "fp"), "", chaos.FaultNone, 200, true, "pi_B")
	var high *Finding
	for _, f := range a.Findings() {
		if f.Code == CodeUnsafeRetry {
			f := f
			high = &f
		}
	}
	if high == nil || high.Severity != High {
		t.Fatalf("expected HIGH finding, got %+v", a.Findings())
	}
	if len(high.ObjectIDs) != 2 || high.ObjectIDs[0] != "pi_A" || high.ObjectIDs[1] != "pi_B" {
		t.Fatalf("object ids = %v, want [pi_A pi_B]", high.ObjectIDs)
	}
	if high.Requests[0] != 1 || high.Requests[1] != 3 {
		t.Fatalf("requests = %v, want [1 3]", high.Requests)
	}
}

// A same-key retry that commits recovers the original; a later identical
// request is not blamed on it.
func TestSameKeyRetryResolvesOriginal(t *testing.T) {
	a, _ := newClocked(0)
	a.Complete(a.Begin("POST", "/v2/checkout/orders", "k1", "fp"), "drop", chaos.FaultDropAfterCommit, 200, true, "pi_A")
	a.Complete(a.Begin("POST", "/v2/checkout/orders", "k1", "fp"), "", chaos.FaultNone, 200, true, "pi_A")
	a.Complete(a.Begin("POST", "/v2/checkout/orders", "k2", "fp"), "", chaos.FaultNone, 200, true, "pi_C")
	if has(a.Findings(), CodeUnsafeRetry) {
		t.Fatalf("recovered original still produced a finding: %+v", a.Findings())
	}
}

func TestUnreconciledCommittedFailure(t *testing.T) {
	a, _ := newClocked(0)
	a.Complete(a.Begin("POST", "/v2/checkout/orders", "k1", "fp1"), "500ac", chaos.FaultError500AfterCommit, 200, true, "pi_A")
	if severityOf(a.Findings(), CodeUnreconciled) != Medium {
		t.Fatalf("committed 500 with no retry should be reported, got %+v", a.Findings())
	}
	// Once it is retried with the same key, it is recovered, not unreconciled.
	a.Complete(a.Begin("POST", "/v2/checkout/orders", "k1", "fp1"), "", chaos.FaultNone, 200, true, "pi_A")
	if has(a.Findings(), CodeUnreconciled) {
		t.Fatalf("recovered request still reported: %+v", a.Findings())
	}
}

func TestFingerprintCanonicalisesJSON(t *testing.T) {
	ct := "application/json"
	a := Fingerprint("acct", "POST", "/v2/checkout/orders", ct, []byte(`{"intent":"CAPTURE","purchase_units":[{"amount":{"currency_code":"USD","value":"10.00"}}]}`))
	b := Fingerprint("acct", "POST", "/v2/checkout/orders", ct, []byte("{\n  \"purchase_units\": [ { \"amount\": { \"value\": \"10.00\", \"currency_code\": \"USD\" } } ],\n  \"intent\": \"CAPTURE\"\n}"))
	c := Fingerprint("acct", "POST", "/v2/checkout/orders", ct, []byte(`{"intent":"CAPTURE","purchase_units":[{"amount":{"currency_code":"USD","value":"10.01"}}]}`))
	if a != b {
		t.Fatal("key order or whitespace changed the fingerprint of a JSON body")
	}
	if a == c {
		t.Fatal("a different amount produced the same fingerprint")
	}
	// Numbers are kept as written, not rounded through float64.
	x := Fingerprint("acct", "POST", "/p", ct, []byte(`{"n":12345678901234567890}`))
	y := Fingerprint("acct", "POST", "/p", ct, []byte(`{"n":12345678901234567891}`))
	if x == y {
		t.Fatal("large numbers collapsed to one fingerprint")
	}
	// A JSON body sent without a content type is still canonicalised.
	if Fingerprint("acct", "POST", "/p", "", []byte(`{"a":1,"b":2}`)) != Fingerprint("acct", "POST", "/p", ct, []byte(`{"b":2,"a":1}`)) {
		t.Fatal("JSON without content type not canonicalised")
	}
}

func TestOperationKeyFromJSONPath(t *testing.T) {
	ct := "application/json"
	ops := []string{"purchase_units.0.invoice_id"}
	k1, ok1 := OperationKey("acct", "POST", "/v2/checkout/orders", ct, []byte(`{"intent":"CAPTURE","purchase_units":[{"invoice_id":"INV-7","amount":{"value":"1.00"}}],"attempt":1}`), ops)
	k2, ok2 := OperationKey("acct", "POST", "/v2/checkout/orders", ct, []byte(`{"attempt":2,"purchase_units":[{"amount":{"value":"1.00"},"invoice_id":"INV-7"}],"intent":"CAPTURE"}`), ops)
	k3, _ := OperationKey("acct", "POST", "/v2/checkout/orders", ct, []byte(`{"purchase_units":[{"invoice_id":"INV-8"}]}`), ops)
	if !ok1 || !ok2 || k1 != k2 {
		t.Fatalf("same invoice id should group: %v %v %q %q", ok1, ok2, k1, k2)
	}
	if k1 == k3 {
		t.Fatal("different invoice ids grouped together")
	}
	if _, ok := OperationKey("acct", "POST", "/p", ct, []byte(`{"purchase_units":[]}`), ops); ok {
		t.Fatal("missing path should not produce a key")
	}
	if _, ok := OperationKey("acct", "POST", "/p", "application/x-www-form-urlencoded", []byte(`order=1`), []string{"order"}); !ok {
		t.Fatal("form operation ids still work")
	}
}

func TestRequestIDTooLong(t *testing.T) {
	a, _ := newClocked(0)
	a.Begin("POST", "/v2/checkout/orders", "0123456789012345678901234567890123456789", "fp")
	if severityOf(a.Findings(), CodeRequestIDTooLong) != Low {
		t.Fatalf("want LOW %s, got %+v", CodeRequestIDTooLong, a.Findings())
	}
	b, _ := newClocked(0)
	b.Begin("POST", "/v2/checkout/orders", "6f1c1e0a-3b7e-4b8f-9a42-1c2d3e4f5a6b", "fp")
	if has(b.Findings(), CodeRequestIDTooLong) {
		t.Fatal("a UUID is within the limit")
	}
}

func TestMissingRequestIDOnlyWhereHonoured(t *testing.T) {
	a, _ := newClocked(0)
	a.WithRequestIDPaths([]string{"/v2/checkout/orders"})
	a.Begin("POST", "/v1/payments/payouts", "", "fp1")
	if has(a.Findings(), CodeMissingRequestID) {
		t.Fatal("missing id reported on an endpoint configured as not honouring it")
	}
	a.Begin("POST", "/v2/checkout/orders", "", "fp2")
	if !has(a.Findings(), CodeMissingRequestID) {
		t.Fatal("missing id not reported")
	}
}

func TestOperationNames(t *testing.T) {
	cases := map[string]string{
		"/v2/checkout/orders":                                   "create_order",
		"/v2/checkout/orders/5O190127TN364715T/capture":         "capture_order",
		"/v2/checkout/orders/5O190127TN364715T/authorize":       "authorize_order",
		"/v2/payments/authorizations/0VF52814937998046/capture": "capture_authorization",
		"/v2/payments/captures/2GG279541U471931P/refund":        "refund_capture",
		"/v1/payments/payouts":                                  "create_payout",
		"/v2/checkout/orders/X":                                 "",
	}
	for path, want := range cases {
		if got := Operation("POST", path); got != want {
			t.Errorf("Operation(%s) = %q, want %q", path, got, want)
		}
	}
	if Operation("GET", "/v2/checkout/orders") != "" {
		t.Error("GET named as an operation")
	}
}

const capturePath = "/v2/checkout/orders/ORDER1/capture"

// Lost capture response, retry without the request id gets 422
// ORDER_ALREADY_CAPTURED, and the client never looks the order up.
func TestAlreadyCapturedNotReconciled(t *testing.T) {
	a, _ := newClocked(0)
	a.Complete(a.Begin("POST", capturePath, "", "fp"), "drop", chaos.FaultDropAfterCommit, 201, true, "CAP1")
	seq := a.Begin("POST", capturePath, "", "fp")
	a.CompleteWith(seq, Outcome{Fault: chaos.FaultNone, UpstreamStatus: 422, Issue: "ORDER_ALREADY_CAPTURED"})
	fs := a.Findings()
	if severityOf(fs, CodeAlreadyCaptured) != Medium {
		t.Fatalf("want %s, got %+v", CodeAlreadyCaptured, fs)
	}
	if has(fs, CodeWouldDuplicate) {
		t.Fatal("PayPal blocked the duplicate; it must not be reported as a would-be duplicate")
	}
	for _, f := range fs {
		if f.Code == CodeAlreadyCaptured && (len(f.Requests) != 2 || f.Requests[0] != 1 || f.Requests[1] != 2) {
			t.Fatalf("requests = %v, want [1 2]", f.Requests)
		}
	}
}

// The same, but the client follows PayPal's advice and GETs the order.
func TestAlreadyCapturedThenFetched(t *testing.T) {
	a, _ := newClocked(0)
	a.Complete(a.Begin("POST", capturePath, "", "fp"), "drop", chaos.FaultDropAfterCommit, 201, true, "CAP1")
	seq := a.Begin("POST", capturePath, "", "fp")
	a.CompleteWith(seq, Outcome{UpstreamStatus: 422, Issue: "ORDER_ALREADY_CAPTURED"})
	a.Observe("GET", "/v2/checkout/orders/ORDER1")
	if fs := a.Findings(); has(fs, CodeAlreadyCaptured) || has(fs, CodeUnreconciled) {
		t.Fatalf("client reconciled, got %+v", fs)
	}
}

// A GET of the order made *before* the 422 does not count.
func TestEarlierGetDoesNotCount(t *testing.T) {
	a, _ := newClocked(0)
	a.Observe("GET", "/v2/checkout/orders/ORDER1")
	a.CompleteWith(a.Begin("POST", capturePath, "", "fp"), Outcome{UpstreamStatus: 422, Issue: "ORDER_ALREADY_CAPTURED"})
	if !has(a.Findings(), CodeAlreadyCaptured) {
		t.Fatal("expected finding")
	}
}

func TestTokenNotRefreshed(t *testing.T) {
	a, _ := newClocked(0)
	a.TokenUsed("tokA", "POST", "/v2/checkout/orders", 1)
	a.TokenRejected("tokA", "POST", "/v2/checkout/orders", 1)
	a.TokenUsed("tokB", "POST", "/v2/checkout/orders", 2) // refreshed: fine
	if has(a.Findings(), CodeTokenNotRefreshed) {
		t.Fatal("a refreshed token was flagged")
	}
	a.TokenUsed("tokA", "GET", "/v2/checkout/orders/X", 0)
	a.TokenUsed("tokA", "GET", "/v2/checkout/orders/X", 0)
	n := 0
	for _, f := range a.Findings() {
		if f.Code == CodeTokenNotRefreshed {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("want exactly one %s, got %d", CodeTokenNotRefreshed, n)
	}
}

func TestHooksSeeRecordsAndFindings(t *testing.T) {
	var recs []Record
	var fs []Finding
	a, _ := newClocked(0)
	a.WithHooks(Hooks{OnRecord: func(r Record) { recs = append(recs, r) }, OnFinding: func(f Finding) { fs = append(fs, f) }})
	a.Complete(a.Begin("POST", "/v2/checkout/orders", "", "fp"), "", chaos.FaultNone, 201, true, "O1")
	if len(recs) != 1 || recs[0].ObjectID != "O1" || recs[0].Operation != "create_order" {
		t.Fatalf("records %+v", recs)
	}
	if len(fs) != 1 || fs[0].Code != CodeMissingRequestID {
		t.Fatalf("findings %+v", fs)
	}
}

func TestFindingsOrderIsStable(t *testing.T) {
	a, _ := newClocked(0) // every finding gets the same timestamp
	a.Begin("POST", "/v2/checkout/orders", "", "fp1")
	a.Begin("POST", "/v2/checkout/orders", "0123456789012345678901234567890123456789", "fp2")
	a.Begin("POST", "/v2/payments/captures/C/refund", "", "fp3")
	first := a.Findings()
	for i := 0; i < 20; i++ {
		again := a.Findings()
		for j := range first {
			if first[j].Code != again[j].Code || first[j].Path != again[j].Path {
				t.Fatal("finding order changed between calls")
			}
		}
	}
}
