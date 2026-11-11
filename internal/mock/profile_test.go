package mock

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func intp(i int) *int { return &i }

// A measured profile changes only the behaviours it records.
func TestProfileChangesAnswers(t *testing.T) {
	s := NewWithOptions(Options{Profile: &Profile{Schema: ProfileSchema, Provider: "paypal", Behaviour: Behaviour{
		ReplayStatus:                   intp(200),
		AlreadyCaptured:                &Answer{Status: 409, Issue: "DUPLICATE_INVOICE_ID"},
		RepeatRefundWithoutID:          &Answer{Status: 422, Issue: "DUPLICATE_REQUEST_ID"},
		CreateOrderWithSourceWithoutID: &Answer{Status: 422, Issue: "PAYPAL_REQUEST_ID_REQUIRED"},
	}}})

	if st, v := do(t, s, "POST", "/v2/checkout/orders", "", approvedOrder); st != 422 || issue(v) != "PAYPAL_REQUEST_ID_REQUIRED" {
		t.Fatalf("create without id: %d %v", st, v)
	}
	if st, _ := do(t, s, "POST", "/v2/checkout/orders", "", `{"intent":"CAPTURE","purchase_units":[{"amount":{"currency_code":"USD","value":"1.00"}}]}`); st != 201 {
		t.Fatalf("create without payment_source is not refused: %d", st)
	}
	st, o := do(t, s, "POST", "/v2/checkout/orders", "o-1", approvedOrder)
	if st != 201 {
		t.Fatalf("create with id: %d", st)
	}
	id := o["id"].(string)
	st, c := do(t, s, "POST", "/v2/checkout/orders/"+id+"/capture", "cap-1", "")
	if st != 201 {
		t.Fatalf("capture: %d", st)
	}
	if st, _ := do(t, s, "POST", "/v2/checkout/orders/"+id+"/capture", "cap-1", ""); st != 200 {
		t.Fatalf("replay status %d, want the measured 200", st)
	}
	if st, v := do(t, s, "POST", "/v2/checkout/orders/"+id+"/capture", "cap-2", ""); st != 409 || issue(v) != "DUPLICATE_INVOICE_ID" {
		t.Fatalf("already captured: %d %v", st, v)
	}
	half := `{"amount":{"currency_code":"USD","value":"10.00"}}`
	cap := captureID(c)
	if st, _ := do(t, s, "POST", "/v2/payments/captures/"+cap+"/refund", "", half); st != 201 {
		t.Fatalf("first refund: %d", st)
	}
	if st, v := do(t, s, "POST", "/v2/payments/captures/"+cap+"/refund", "", half); st != 422 || issue(v) != "DUPLICATE_REQUEST_ID" {
		t.Fatalf("second refund without id: %d %v", st, v)
	}
	if st, _ := do(t, s, "POST", "/v2/payments/captures/"+cap+"/refund", "r-2", half); st != 201 {
		t.Fatalf("second refund with id: %d", st)
	}
}

func TestLoadProfileValidates(t *testing.T) {
	dir := t.TempDir()
	write := func(body string) string {
		p := filepath.Join(dir, "p.json")
		if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
		return p
	}
	if _, err := LoadProfile(write(`{"schema":1,"provider":"paypal","behaviour":{"replay_status":200}}`)); err != nil {
		t.Fatal(err)
	}
	for body, want := range map[string]string{
		`{"schema":2,"provider":"paypal"}`:                                            "schema",
		`{"schema":1,"provider":"stripe"}`:                                            "provider",
		`{"schema":1,"provider":"paypal","behaviour":{"replay_status":9}}`:            "replay status",
		`{"schema":1,"provider":"paypal","behaviour":{"expired_token":{"status":0}}}`: "invalid status",
		`not json`: "parse",
	} {
		if _, err := LoadProfile(write(body)); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: err %v, want %q", body, err, want)
		}
	}
}
