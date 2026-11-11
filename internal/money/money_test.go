package money

import "testing"

func TestParse(t *testing.T) {
	cases := []struct {
		v, cur string
		want   int64
		ok     bool
	}{
		{"10.00", "USD", 1000, true},
		{"10.5", "usd", 1050, true},
		{"10", "EUR", 1000, true},
		{"0.01", "USD", 1, true},
		{"1000", "JPY", 1000, true},
		{"1000.00", "JPY", 1000, true}, // trailing zeros are harmless
		{"1000.50", "JPY", 0, false},   // JPY has no minor unit
		{"10.001", "USD", 0, false},
		{"10.000", "USD", 1000, true},
		{"-5.00", "USD", 0, false},
		{"1e3", "USD", 0, false},
		{".5", "USD", 0, false},
		{"", "USD", 0, false},
		{"10.00", "", 0, false},
		{"10.00", "US", 0, false},
		{"99999999999999999999999", "USD", 0, false},
	}
	for _, c := range cases {
		got, ok := Parse(c.v, c.cur)
		if ok != c.ok || (ok && got.Minor != c.want) {
			t.Errorf("Parse(%q, %q) = %+v, %v; want %d, %v", c.v, c.cur, got, ok, c.want, c.ok)
		}
	}
}

func TestFromRequest(t *testing.T) {
	cases := []struct {
		op, body string
		want     Amount
		ok       bool
	}{
		{"create_order", `{"purchase_units":[{"amount":{"currency_code":"USD","value":"20.00"}},{"amount":{"currency_code":"USD","value":"5.50"}}]}`, Amount{2550, "USD"}, true},
		{"create_order", `{"purchase_units":[{"amount":{"currency_code":"USD","value":"20.00"}},{"amount":{"currency_code":"EUR","value":"5.50"}}]}`, Amount{}, false},
		{"refund_capture", `{"amount":{"currency_code":"EUR","value":"7.25"}}`, Amount{725, "EUR"}, true},
		{"refund_capture", `{}`, Amount{}, false}, // full refund: amount comes from the response
		{"refund_capture", ``, Amount{}, false},
		{"capture_order", `{}`, Amount{}, false},
		{"capture_authorization", `{"amount":{"currency_code":"USD","value":"3.00"},"final_capture":true}`, Amount{300, "USD"}, true},
		{"create_payout", `{"items":[{"amount":{"currency":"USD","value":"1.00"}},{"amount":{"currency":"USD","value":"2.00"}}]}`, Amount{300, "USD"}, true},
		{"create_order", `not json`, Amount{}, false},
		{"", `{"amount":{"currency_code":"USD","value":"1.00"}}`, Amount{}, false},
	}
	for _, c := range cases {
		got, ok := FromRequest(c.op, []byte(c.body))
		if ok != c.ok || got != c.want {
			t.Errorf("FromRequest(%s, %s) = %+v, %v; want %+v, %v", c.op, c.body, got, ok, c.want, c.ok)
		}
	}
}

func TestFromResponse(t *testing.T) {
	capture := `{"id":"ORD","status":"COMPLETED","purchase_units":[{"amount":{"currency_code":"USD","value":"50.00"},"payments":{"captures":[{"id":"C1","amount":{"currency_code":"USD","value":"50.00"}}]}}]}`
	auth := `{"id":"ORD","purchase_units":[{"payments":{"authorizations":[{"id":"A1","amount":{"currency_code":"GBP","value":"12.00"}}]}}]}`
	cases := []struct {
		op, body string
		want     Amount
		ok       bool
	}{
		{"capture_order", capture, Amount{5000, "USD"}, true},
		{"authorize_order", auth, Amount{1200, "GBP"}, true},
		{"create_order", capture, Amount{5000, "USD"}, true},
		{"refund_capture", `{"id":"R","amount":{"currency_code":"USD","value":"50.00"}}`, Amount{5000, "USD"}, true},
		{"create_payout", `{"batch_header":{"amount":{"currency":"USD","value":"9.00"}}}`, Amount{900, "USD"}, true},
		{"create_payout", `{"batch_header":{"payout_batch_id":"X"}}`, Amount{}, false},
		{"capture_order", `{"id":"ORD"}`, Amount{}, false},
	}
	for _, c := range cases {
		got, ok := FromResponse(c.op, []byte(c.body))
		if ok != c.ok || got != c.want {
			t.Errorf("FromResponse(%s) = %+v, %v; want %+v, %v", c.op, got, ok, c.want, c.ok)
		}
	}
}

func TestFormat(t *testing.T) {
	cases := map[Amount]string{
		{125000, "USD"}:   "1,250.00 USD",
		{5, "USD"}:        "0.05 USD",
		{0, "EUR"}:        "0.00 EUR",
		{1234567, "JPY"}:  "1,234,567 JPY",
		{100, "USD"}:      "1.00 USD",
		{-250, "USD"}:     "-2.50 USD",
		{Minor: 9}:        "amount unknown",
		{99999999, "GBP"}: "999,999.99 GBP",
	}
	for in, want := range cases {
		if got := Format(in); got != want {
			t.Errorf("Format(%+v) = %q, want %q", in, got, want)
		}
	}
	tot := Totals{}
	tot.Add(Amount{100, "USD"})
	tot.Add(Amount{250, "USD"})
	tot.Add(Amount{})
	if tot["USD"] != 350 || len(tot) != 1 {
		t.Fatalf("totals %+v", tot)
	}
}
