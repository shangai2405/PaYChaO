// Package pp is a deliberately small PayPal REST client shared by the example
// integrations. Each example decides how it uses request ids, retries and
// tokens; that is where the bugs paychaos looks for live.
package pp

import (
	"bytes"
	crand "crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Client talks to the PayPal REST API (or paychaos in front of it).
type Client struct {
	Base, ClientID, Secret string
	HTTP                   *http.Client
	Token                  string
}

// New returns a client with a 10s timeout.
func New(base, id, secret string) *Client {
	return &Client{Base: strings.TrimSuffix(base, "/"), ClientID: id, Secret: secret,
		HTTP: &http.Client{Timeout: 10 * time.Second}}
}

// Refresh fetches a new access token with the client-credentials grant.
func (c *Client) Refresh() error {
	req, _ := http.NewRequest(http.MethodPost, c.Base+"/v1/oauth2/token", strings.NewReader("grant_type=client_credentials"))
	req.SetBasicAuth(c.ClientID, c.Secret)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	var tok struct {
		AccessToken string `json:"access_token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&tok); err != nil || tok.AccessToken == "" {
		return fmt.Errorf("token: status %d", resp.StatusCode)
	}
	c.Token = tok.AccessToken
	return nil
}

// Response is a decoded reply. Err is set for network errors and unreadable
// bodies, the cases where the caller cannot know what happened.
type Response struct {
	Status int
	Body   map[string]any
	Err    error
}

// Issue returns details[0].issue of a PayPal error.
func (r Response) Issue() string {
	d, _ := r.Body["details"].([]any)
	if len(d) == 0 {
		return ""
	}
	m, _ := d[0].(map[string]any)
	s, _ := m["issue"].(string)
	return s
}

// Do sends one request. requestID may be empty.
func (c *Client) Do(method, path, requestID string, body any) Response {
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequest(method, c.Base+path, rd)
	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("Content-Type", "application/json")
	if requestID != "" {
		req.Header.Set("PayPal-Request-Id", requestID)
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return Response{Err: err}
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	out := Response{Status: resp.StatusCode, Err: err}
	if err == nil {
		out.Err = json.Unmarshal(raw, &out.Body)
	}
	return out
}

// OK reports a 2xx with a readable body.
func (r Response) OK() bool { return r.Err == nil && r.Status >= 200 && r.Status < 300 }

// Retryable reports a failure worth retrying: network error, unreadable body,
// 401 (after refreshing), 409, 429 or 5xx.
func (r Response) Retryable() bool {
	return r.Err != nil || r.Status == 401 || r.Status == 409 || r.Status == 429 || r.Status >= 500
}

// OrderBody is a CAPTURE order for one invoice, approved up front with a
// payment_source so the mock lets it be captured without a buyer.
func OrderBody(invoice string, cents int) map[string]any {
	return map[string]any{
		"intent": "CAPTURE",
		"purchase_units": []any{map[string]any{
			"invoice_id": invoice,
			"amount":     map[string]any{"currency_code": "USD", "value": fmt.Sprintf("%d.%02d", cents/100, cents%100)},
		}},
		"payment_source": map[string]any{"paypal": map[string]any{}},
	}
}

// RefundBody is a partial refund tagged with an invoice id.
func RefundBody(invoice string, cents int) map[string]any {
	return map[string]any{
		"invoice_id": invoice,
		"amount":     map[string]any{"currency_code": "USD", "value": fmt.Sprintf("%d.%02d", cents/100, cents%100)},
	}
}

// CaptureID reads the capture id from a capture-order (or get-order) body.
func CaptureID(body map[string]any) string {
	pus, _ := body["purchase_units"].([]any)
	for _, p := range pus {
		pu, _ := p.(map[string]any)
		pay, _ := pu["payments"].(map[string]any)
		caps, _ := pay["captures"].([]any)
		if len(caps) > 0 {
			c, _ := caps[len(caps)-1].(map[string]any)
			id, _ := c["id"].(string)
			return id
		}
	}
	return ""
}

// UUID returns a random version 4 UUID, the request id PayPal recommends.
func UUID() string {
	b := make([]byte, 16)
	_, _ = crand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
