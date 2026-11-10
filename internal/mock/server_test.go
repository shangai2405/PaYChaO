package mock

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func do(t *testing.T, h http.Handler, method, path, reqID, body string) (int, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer tok")
	req.Header.Set("Content-Type", "application/json")
	if reqID != "" {
		req.Header.Set("PayPal-Request-Id", reqID)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	var v map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &v)
	return w.Code, v
}

const approvedOrder = `{"intent":"CAPTURE","purchase_units":[{"amount":{"currency_code":"USD","value":"20.00"}}],"payment_source":{"paypal":{}}}`

func issue(v map[string]any) string {
	d, _ := v["details"].([]any)
	if len(d) == 0 {
		return ""
	}
	return d[0].(map[string]any)["issue"].(string)
}

func captureID(v map[string]any) string {
	pu := v["purchase_units"].([]any)[0].(map[string]any)
	return pu["payments"].(map[string]any)["captures"].([]any)[0].(map[string]any)["id"].(string)
}

func TestOrderLifecycle(t *testing.T) {
	s := New()
	st, o := do(t, s, "POST", "/v2/checkout/orders", "", approvedOrder)
	if st != 201 || o["status"] != "APPROVED" {
		t.Fatalf("create: %d %v", st, o)
	}
	id := o["id"].(string)
	st, c := do(t, s, "POST", "/v2/checkout/orders/"+id+"/capture", "", "")
	if st != 201 || c["status"] != "COMPLETED" || captureID(c) == "" {
		t.Fatalf("capture: %d %v", st, c)
	}
	st, again := do(t, s, "POST", "/v2/checkout/orders/"+id+"/capture", "", "")
	if st != 422 || issue(again) != "ORDER_ALREADY_CAPTURED" {
		t.Fatalf("second capture: %d %v", st, again)
	}
	st, got := do(t, s, "GET", "/v2/checkout/orders/"+id, "", "")
	if st != 200 || captureID(got) != captureID(c) {
		t.Fatalf("get: %d %v", st, got)
	}
	if s.Created("orders") != 1 || s.Created("captures") != 1 {
		t.Fatalf("stats %d %d", s.Created("orders"), s.Created("captures"))
	}
}

func TestUnapprovedOrderCannotBeCaptured(t *testing.T) {
	s := New()
	_, o := do(t, s, "POST", "/v2/checkout/orders", "", `{"intent":"CAPTURE","purchase_units":[{"amount":{"currency_code":"USD","value":"1.00"}}]}`)
	st, v := do(t, s, "POST", "/v2/checkout/orders/"+o["id"].(string)+"/capture", "", "")
	if st != 422 || issue(v) != "ORDER_NOT_APPROVED" {
		t.Fatalf("%d %v", st, v)
	}
}

// Same id returns the latest state of the resource, not the first response.
func TestSameRequestIDReturnsLatestState(t *testing.T) {
	s := New()
	_, o := do(t, s, "POST", "/v2/checkout/orders", "create-1", approvedOrder)
	id := o["id"].(string)
	do(t, s, "POST", "/v2/checkout/orders/"+id+"/capture", "", "")
	st, again := do(t, s, "POST", "/v2/checkout/orders", "create-1", approvedOrder)
	if st != 201 || again["id"] != id || again["status"] != "COMPLETED" {
		t.Fatalf("want the order's current (captured) state, got %d %v", st, again)
	}
	if s.Created("orders") != 1 {
		t.Fatal("same id created a second order")
	}
}

func TestNoRequestIDProcessesAgain(t *testing.T) {
	s := New()
	do(t, s, "POST", "/v2/checkout/orders", "", approvedOrder)
	do(t, s, "POST", "/v2/checkout/orders", "", approvedOrder)
	if s.Created("orders") != 2 {
		t.Fatalf("created %d", s.Created("orders"))
	}
}

func TestPartialRefunds(t *testing.T) {
	s := New()
	_, o := do(t, s, "POST", "/v2/checkout/orders", "", approvedOrder)
	_, c := do(t, s, "POST", "/v2/checkout/orders/"+o["id"].(string)+"/capture", "", "")
	cap := captureID(c)
	half := `{"amount":{"currency_code":"USD","value":"10.00"}}`
	for i := 0; i < 2; i++ {
		if st, v := do(t, s, "POST", "/v2/payments/captures/"+cap+"/refund", "", half); st != 201 || v["status"] != "COMPLETED" {
			t.Fatalf("refund %d: %d %v", i, st, v)
		}
	}
	st, v := do(t, s, "POST", "/v2/payments/captures/"+cap+"/refund", "", half)
	if st != 422 || issue(v) != "CAPTURE_FULLY_REFUNDED" {
		t.Fatalf("third refund: %d %v", st, v)
	}
	_, got := do(t, s, "GET", "/v2/payments/captures/"+cap, "", "")
	if got["status"] != "REFUNDED" {
		t.Fatalf("capture status %v", got["status"])
	}
	_, o2 := do(t, s, "POST", "/v2/checkout/orders", "", approvedOrder)
	_, c2 := do(t, s, "POST", "/v2/checkout/orders/"+o2["id"].(string)+"/capture", "", "")
	st, v = do(t, s, "POST", "/v2/payments/captures/"+captureID(c2)+"/refund", "", `{"amount":{"currency_code":"USD","value":"99.00"}}`)
	if st != 422 || issue(v) != "REFUND_AMOUNT_EXCEEDED" {
		t.Fatalf("over-refund: %d %v", st, v)
	}
}

func TestAuthorizeAndCapture(t *testing.T) {
	s := New()
	_, o := do(t, s, "POST", "/v2/checkout/orders", "", strings.Replace(approvedOrder, "CAPTURE", "AUTHORIZE", 1))
	st, a := do(t, s, "POST", "/v2/checkout/orders/"+o["id"].(string)+"/authorize", "", "")
	if st != 200 {
		t.Fatalf("authorize: %d %v", st, a)
	}
	pu := a["purchase_units"].([]any)[0].(map[string]any)
	authID := pu["payments"].(map[string]any)["authorizations"].([]any)[0].(map[string]any)["id"].(string)
	st, c := do(t, s, "POST", "/v2/payments/authorizations/"+authID+"/capture", "", "")
	if st != 201 || c["status"] != "COMPLETED" {
		t.Fatalf("capture authorization: %d %v", st, c)
	}
	st, v := do(t, s, "POST", "/v2/payments/authorizations/"+authID+"/capture", "", "")
	if st != 422 || issue(v) != "AUTHORIZATION_ALREADY_CAPTURED" {
		t.Fatalf("second capture: %d %v", st, v)
	}
	st, v = do(t, s, "POST", "/v2/checkout/orders/"+o["id"].(string)+"/authorize", "", "")
	if st != 422 || issue(v) != "ORDER_ALREADY_AUTHORIZED" {
		t.Fatalf("second authorize: %d %v", st, v)
	}
}

func TestPayouts(t *testing.T) {
	s := New()
	body := `{"sender_batch_header":{"sender_batch_id":"batch-1"},"items":[{"recipient_type":"EMAIL","amount":{"value":"1.00","currency":"USD"},"receiver":"a@example.com"}]}`
	st, v := do(t, s, "POST", "/v1/payments/payouts", "", body)
	if st != 201 || v["batch_header"].(map[string]any)["payout_batch_id"] == "" {
		t.Fatalf("%d %v", st, v)
	}
	st, v = do(t, s, "POST", "/v1/payments/payouts", "", body)
	if st != 400 || v["name"] != "USER_BUSINESS_ERROR" {
		t.Fatalf("reused sender_batch_id: %d %v", st, v)
	}
}

func TestInFlightCollision(t *testing.T) {
	s := NewWithOptions(Options{ExecDelay: 150 * time.Millisecond})
	var wg sync.WaitGroup
	statuses := make([]int, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			time.Sleep(time.Duration(i) * 40 * time.Millisecond)
			statuses[i], _ = do(t, s, "POST", "/v2/checkout/orders", "same", approvedOrder)
		}(i)
	}
	wg.Wait()
	if statuses[0] != 201 || statuses[1] != 409 {
		t.Fatalf("statuses %v", statuses)
	}
}

func TestServerErrorAfterCreate(t *testing.T) {
	s := NewWithOptions(Options{ServerErrorEvery: 1})
	st, _ := do(t, s, "POST", "/v2/checkout/orders", "k", approvedOrder)
	if st != 500 || s.Created("orders") != 1 {
		t.Fatalf("%d %d", st, s.Created("orders"))
	}
	st, v := do(t, s, "POST", "/v2/checkout/orders", "k", approvedOrder)
	if st != 201 || v["id"] == nil {
		t.Fatalf("same id after 500 should return the order: %d %v", st, v)
	}
}

func TestTokens(t *testing.T) {
	s := NewWithOptions(Options{StrictTokens: true})
	req := httptest.NewRequest("POST", "/v1/oauth2/token", strings.NewReader("grant_type=client_credentials"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.SetBasicAuth("id", "secret")
	w := httptest.NewRecorder()
	s.ServeHTTP(w, req)
	var tok map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &tok)
	if w.Code != 200 || tok["token_type"] != "Bearer" {
		t.Fatalf("%d %v", w.Code, tok)
	}
	if st, _ := do(t, s, "POST", "/v2/checkout/orders", "", approvedOrder); st != 401 {
		t.Fatalf("unknown token accepted in strict mode: %d", st)
	}
	r := httptest.NewRequest("POST", "/v2/checkout/orders", bytes.NewReader([]byte(approvedOrder)))
	r.Header.Set("Authorization", "Bearer "+tok["access_token"].(string))
	w = httptest.NewRecorder()
	s.ServeHTTP(w, r)
	if w.Code != 201 {
		t.Fatalf("issued token rejected: %d", w.Code)
	}
}

func TestValidation(t *testing.T) {
	s := New()
	for _, body := range []string{`nope`, `{"intent":"SALE","purchase_units":[{}]}`, `{"intent":"CAPTURE"}`,
		`{"intent":"CAPTURE","purchase_units":[{"amount":{"value":"x"}}]}`} {
		if st, _ := do(t, s, "POST", "/v2/checkout/orders", "", body); st != 400 {
			t.Errorf("%s: %d", body, st)
		}
	}
	if st, _ := do(t, s, "GET", "/v2/checkout/orders/NOPE", "", ""); st != 404 {
		t.Error("missing order should 404")
	}
	if st, _ := do(t, s, "POST", "/v9/what", "", ""); st != 404 {
		t.Error("unknown path should 404")
	}
}
