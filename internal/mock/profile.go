package mock

import (
	"encoding/json"
	"fmt"
	"os"
	"time"
)

// ProfileSchema is the version of the provider profile format.
const ProfileSchema = 1

// Profile records how the real PayPal sandbox behaved when `paychaos
// verify-sandbox` measured it. The mock reads it (paychaos -upstream mock
// -mock-profile FILE) to answer the way the sandbox did instead of the way
// the mock assumes. Every behaviour is optional: nil means "not measured",
// and the mock keeps its default for it.
type Profile struct {
	Schema     int       `json:"schema"`
	Provider   string    `json:"provider"`
	Host       string    `json:"host"`
	MeasuredAt time.Time `json:"measured_at"`
	Engine     string    `json:"engine_version,omitempty"`
	Checks     []Check   `json:"checks"`
	Behaviour  Behaviour `json:"behaviour"`
}

// Check is one measured behaviour, with what the mock assumed beside it.
type Check struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	Status   string `json:"status"` // matches, differs, failed, skipped
	Assumed  string `json:"assumed"`
	Observed string `json:"observed"`
	Detail   string `json:"detail,omitempty"`
}

// Answer is an HTTP status and PayPal error issue.
type Answer struct {
	Status int    `json:"status"`
	Issue  string `json:"issue,omitempty"`
}

// Behaviour is what the mock can be told to do differently.
type Behaviour struct {
	// ReplayStatus is the status of a repeated capture with the same
	// PayPal-Request-Id (the mock's default repeats the original status).
	ReplayStatus *int `json:"replay_status,omitempty"`
	// AlreadyCaptured is the answer to capturing a captured order with a new
	// or no request id (default 422 ORDER_ALREADY_CAPTURED).
	AlreadyCaptured *Answer `json:"already_captured,omitempty"`
	// RepeatRefundWithoutID is the answer to a second partial refund of one
	// capture without a request id (default: it succeeds, 201).
	RepeatRefundWithoutID *Answer `json:"repeat_refund_without_id,omitempty"`
	// CreateOrderWithSourceWithoutID is the answer to creating an order that
	// has a payment_source but no request id (default: it succeeds, 201).
	CreateOrderWithSourceWithoutID *Answer `json:"create_order_with_source_without_id,omitempty"`
	// CaptureIDInPurchaseUnits records whether the capture-order response
	// carries the capture under purchase_units[].payments.captures[].
	CaptureIDInPurchaseUnits *bool `json:"capture_id_in_purchase_units,omitempty"`
	// ExpiredToken is the answer to an invalid or expired access token.
	ExpiredToken *Answer `json:"expired_token,omitempty"`
}

// LoadProfile reads and checks a profile file.
func LoadProfile(path string) (Profile, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return Profile{}, err
	}
	var p Profile
	if err := json.Unmarshal(b, &p); err != nil {
		return Profile{}, fmt.Errorf("parse %s: %w", path, err)
	}
	if p.Schema != ProfileSchema {
		return Profile{}, fmt.Errorf("%s: profile schema %d, this paychaos reads %d", path, p.Schema, ProfileSchema)
	}
	if p.Provider != "paypal" {
		return Profile{}, fmt.Errorf("%s: provider %q, want paypal", path, p.Provider)
	}
	if rs := p.Behaviour.ReplayStatus; rs != nil && (*rs < 100 || *rs > 599) {
		return Profile{}, fmt.Errorf("%s: invalid replay status %d", path, *rs)
	}
	for _, a := range []*Answer{p.Behaviour.AlreadyCaptured, p.Behaviour.RepeatRefundWithoutID, p.Behaviour.CreateOrderWithSourceWithoutID, p.Behaviour.ExpiredToken} {
		if a != nil && (a.Status < 100 || a.Status > 599) {
			return Profile{}, fmt.Errorf("%s: invalid status %d", path, a.Status)
		}
	}
	return p, nil
}

func (s *Server) behaviour() Behaviour {
	if s.opt.Profile == nil {
		return Behaviour{}
	}
	return s.opt.Profile.Behaviour
}
