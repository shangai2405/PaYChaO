// Package money reads the amount a PayPal request moves, so findings can say
// how much money a bug would duplicate or lose.
//
// Amounts are kept in minor units (cents for USD, yen for JPY) as int64 and
// are never converted to floating point. Amounts in different currencies are
// never added together.
package money

import (
	"bytes"
	"encoding/json"
	"strings"
)

// Amount is a quantity of one currency in minor units.
type Amount struct {
	Minor    int64  `json:"amount_minor"`
	Currency string `json:"currency"`
}

// Known reports whether the amount was found.
func (a Amount) Known() bool { return a.Currency != "" }

// exponent returns the number of minor-unit digits of a currency. PayPal
// supports these zero-decimal currencies; everything else it supports has
// two decimals (PayPal has no three-decimal currencies).
func exponent(currency string) int {
	switch currency {
	case "JPY", "HUF", "TWD":
		return 0
	}
	return 2
}

// Parse converts a PayPal decimal string ("10.5", "1000") in currency into
// minor units. It rejects negative numbers, exponents and more decimals than
// the currency has.
func Parse(value, currency string) (Amount, bool) {
	currency = strings.ToUpper(strings.TrimSpace(currency))
	value = strings.TrimSpace(value)
	if len(currency) != 3 || value == "" {
		return Amount{}, false
	}
	whole, frac, _ := strings.Cut(value, ".")
	exp := exponent(currency)
	if whole == "" || len(frac) > exp && strings.Trim(frac[exp:], "0") != "" {
		return Amount{}, false
	}
	if len(frac) > exp {
		frac = frac[:exp]
	}
	frac += strings.Repeat("0", exp-len(frac))
	var n int64
	for _, c := range whole + frac {
		if c < '0' || c > '9' {
			return Amount{}, false
		}
		if n > (1<<62)/10 {
			return Amount{}, false // absurdly large; refuse rather than overflow
		}
		n = n*10 + int64(c-'0')
	}
	return Amount{Minor: n, Currency: currency}, true
}

type pmoney struct {
	Value        string `json:"value"`
	CurrencyCode string `json:"currency_code"`
	// Payouts use "currency" instead of "currency_code".
	Currency string `json:"currency"`
}

func (m *pmoney) amount() (Amount, bool) {
	if m == nil {
		return Amount{}, false
	}
	cur := m.CurrencyCode
	if cur == "" {
		cur = m.Currency
	}
	return Parse(m.Value, cur)
}

// sum adds amounts of one currency. Mixed currencies, or none, give false:
// a single request moving two currencies is not something PayPal accepts.
func sum(ms []*pmoney) (Amount, bool) {
	var out Amount
	for _, m := range ms {
		a, ok := m.amount()
		if !ok {
			continue
		}
		if out.Currency != "" && out.Currency != a.Currency {
			return Amount{}, false
		}
		out.Currency = a.Currency
		out.Minor += a.Minor
	}
	return out, out.Currency != ""
}

func decode(body []byte, v any) bool {
	if len(bytes.TrimSpace(body)) == 0 {
		return false
	}
	return json.Unmarshal(body, v) == nil
}

// FromRequest reads the amount a money-moving request asks for. operation is
// audit.Operation's name for the request. A capture of an order or of a full
// authorization, or a refund without an amount, carries none: their amount
// comes from the response (FromResponse).
func FromRequest(operation string, body []byte) (Amount, bool) {
	switch operation {
	case "create_order":
		var b struct {
			PurchaseUnits []struct {
				Amount *pmoney `json:"amount"`
			} `json:"purchase_units"`
		}
		if !decode(body, &b) {
			return Amount{}, false
		}
		ms := make([]*pmoney, 0, len(b.PurchaseUnits))
		for _, pu := range b.PurchaseUnits {
			ms = append(ms, pu.Amount)
		}
		return sum(ms)
	case "capture_authorization", "refund_capture":
		var b struct {
			Amount *pmoney `json:"amount"`
		}
		if !decode(body, &b) {
			return Amount{}, false
		}
		return b.Amount.amount()
	case "create_payout":
		var b struct {
			Items []struct {
				Amount *pmoney `json:"amount"`
			} `json:"items"`
		}
		if !decode(body, &b) {
			return Amount{}, false
		}
		ms := make([]*pmoney, 0, len(b.Items))
		for _, it := range b.Items {
			ms = append(ms, it.Amount)
		}
		return sum(ms)
	}
	return Amount{}, false
}

// FromResponse reads the amount a successful response says was moved. For an
// order capture or authorization that is the newest capture or authorization
// in each purchase unit; for a refund or authorization capture it is the
// resource's own amount; for a created order, the purchase units' amounts.
func FromResponse(operation string, body []byte) (Amount, bool) {
	switch operation {
	case "capture_order", "authorize_order", "create_order":
		var b struct {
			PurchaseUnits []struct {
				Amount   *pmoney `json:"amount"`
				Payments struct {
					Captures       []struct{ Amount *pmoney } `json:"captures"`
					Authorizations []struct{ Amount *pmoney } `json:"authorizations"`
				} `json:"payments"`
			} `json:"purchase_units"`
		}
		if !decode(body, &b) {
			return Amount{}, false
		}
		var ms []*pmoney
		for _, pu := range b.PurchaseUnits {
			switch {
			case operation == "capture_order" && len(pu.Payments.Captures) > 0:
				ms = append(ms, pu.Payments.Captures[len(pu.Payments.Captures)-1].Amount)
			case operation == "authorize_order" && len(pu.Payments.Authorizations) > 0:
				ms = append(ms, pu.Payments.Authorizations[len(pu.Payments.Authorizations)-1].Amount)
			case operation == "create_order":
				ms = append(ms, pu.Amount)
			}
		}
		return sum(ms)
	case "capture_authorization", "refund_capture":
		var b struct {
			Amount *pmoney `json:"amount"`
		}
		if !decode(body, &b) {
			return Amount{}, false
		}
		return b.Amount.amount()
	case "create_payout":
		var b struct {
			BatchHeader struct {
				Amount *pmoney `json:"amount"`
			} `json:"batch_header"`
		}
		if !decode(body, &b) {
			return Amount{}, false
		}
		return b.BatchHeader.Amount.amount()
	}
	return Amount{}, false
}

// Format renders an amount for people: "1,250.00 USD", "500 JPY".
func Format(a Amount) string {
	if !a.Known() {
		return "amount unknown"
	}
	exp := exponent(a.Currency)
	n := a.Minor
	neg := n < 0
	if neg {
		n = -n
	}
	digits := []byte(itoa(n))
	for len(digits) <= exp {
		digits = append([]byte{'0'}, digits...)
	}
	whole, frac := digits[:len(digits)-exp], digits[len(digits)-exp:]
	var b strings.Builder
	if neg {
		b.WriteByte('-')
	}
	for i, c := range whole {
		if i > 0 && (len(whole)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteByte(c)
	}
	if exp > 0 {
		b.WriteByte('.')
		b.Write(frac)
	}
	b.WriteByte(' ')
	b.WriteString(a.Currency)
	return b.String()
}

func itoa(n int64) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}

// Totals adds amounts per currency.
type Totals map[string]int64

// Add includes a (ignored when unknown).
func (t Totals) Add(a Amount) {
	if a.Known() {
		t[a.Currency] += a.Minor
	}
}
