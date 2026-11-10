// Package mock is a small PayPal-shaped REST API used for demos and tests, so
// the tool can be tried without a PayPal developer account. It implements:
//
//	POST /v1/oauth2/token                          client-credentials token
//	POST /v2/checkout/orders                       create order
//	GET  /v2/checkout/orders/{id}                  show order
//	POST /v2/checkout/orders/{id}/capture          capture order       (201)
//	POST /v2/checkout/orders/{id}/authorize        authorize order     (200)
//	GET  /v2/payments/authorizations/{id}
//	POST /v2/payments/authorizations/{id}/capture  capture authorization (201)
//	GET  /v2/payments/captures/{id}
//	POST /v2/payments/captures/{id}/refund         refund capture      (201)
//	GET  /v2/payments/refunds/{id}
//	POST /v1/payments/payouts                      create payout batch (201)
//	GET  /v1/payments/payouts/{id}
//
// and PayPal's documented idempotency semantics for PayPal-Request-Id:
//
//   - a retry with the same id returns the *latest state* of the resource the
//     first request produced, not a replay of the original response;
//   - a request without an id is processed again;
//   - a second request with an id that is still executing gets 409;
//   - capturing an already captured order is 422 ORDER_ALREADY_CAPTURED.
//
// Options can slow execution down (to produce collisions), make some
// executions fail with a 500 after the resource was created, and expire
// request ids early to test late retries.
//
// It is NOT a PayPal emulator. Behaviour the build plan lists under "Verify in
// sandbox first" is modelled on a best guess and marked as such below.
package mock

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Options tune the mock's behaviour.
type Options struct {
	// ExecDelay is how long each money-moving POST takes to execute. A retry
	// that reuses the request id while the first attempt runs gets a 409.
	ExecDelay time.Duration
	// ServerErrorEvery makes every Nth executed POST return 500 after the
	// resource has been created (0 disables). A same-id retry then gets the
	// resource's current state, as PayPal documents.
	ServerErrorEvery int
	// RequestIDTTL forgets request ids after this long (0 = never). PayPal
	// keeps them for a period that varies by API (6 hours to 45 days); a
	// short TTL tests what a late retry does once the id has expired.
	RequestIDTTL time.Duration
	// StrictTokens rejects bearer tokens the mock did not issue. Off by
	// default so tests can use any token.
	StrictTokens bool
}

type money struct {
	CurrencyCode string `json:"currency_code"`
	Value        string `json:"value"`
}

type link struct {
	Href   string `json:"href"`
	Rel    string `json:"rel"`
	Method string `json:"method"`
}

type capture struct {
	ID           string  `json:"id"`
	Status       string  `json:"status"`
	Amount       money   `json:"amount"`
	FinalCapture bool    `json:"final_capture"`
	CreateTime   string  `json:"create_time"`
	Links        []link  `json:"links"`
	refunded     float64 // cents
	total        float64 // cents
}

type authorization struct {
	ID         string `json:"id"`
	Status     string `json:"status"`
	Amount     money  `json:"amount"`
	CreateTime string `json:"create_time"`
	Links      []link `json:"links"`
}

type refund struct {
	ID         string `json:"id"`
	Status     string `json:"status"`
	Amount     money  `json:"amount"`
	CreateTime string `json:"create_time"`
	Links      []link `json:"links"`
}

type purchaseUnit struct {
	ReferenceID string        `json:"reference_id"`
	InvoiceID   string        `json:"invoice_id,omitempty"`
	CustomID    string        `json:"custom_id,omitempty"`
	Amount      money         `json:"amount"`
	Payments    *unitPayments `json:"payments,omitempty"`
}

type unitPayments struct {
	Captures       []*capture       `json:"captures,omitempty"`
	Authorizations []*authorization `json:"authorizations,omitempty"`
}

type order struct {
	ID            string          `json:"id"`
	Intent        string          `json:"intent"`
	Status        string          `json:"status"`
	PurchaseUnits []*purchaseUnit `json:"purchase_units"`
	CreateTime    string          `json:"create_time"`
	Links         []link          `json:"links"`
}

type payout struct {
	BatchHeader struct {
		PayoutBatchID     string          `json:"payout_batch_id"`
		BatchStatus       string          `json:"batch_status"`
		SenderBatchHeader json.RawMessage `json:"sender_batch_header"`
	} `json:"batch_header"`
	Links []link `json:"links"`
}

// remembered is what a PayPal-Request-Id maps to: which resource the first
// request produced and the status it answered with.
type remembered struct {
	kind, id string
	status   int
	at       time.Time
}

// Server is an http.Handler.
type Server struct {
	opt Options
	now func() time.Time

	mu       sync.Mutex
	attempts int
	inflight map[string]bool
	reqIDs   map[string]remembered
	tokens   map[string]string // access token -> client id
	orders   map[string]*order
	auths    map[string]*authorization
	authOrd  map[string]*order
	captures map[string]*capture
	refunds  map[string]*refund
	payouts  map[string]*payout
	batchIDs map[string]bool // sender_batch_id already used
	created  map[string]int
}

// New returns an empty mock.
func New() *Server { return NewWithOptions(Options{}) }

// NewWithOptions returns an empty mock with the given options.
func NewWithOptions(o Options) *Server {
	return &Server{opt: o, now: time.Now,
		inflight: map[string]bool{}, reqIDs: map[string]remembered{}, tokens: map[string]string{},
		orders: map[string]*order{}, auths: map[string]*authorization{}, authOrd: map[string]*order{},
		captures: map[string]*capture{}, refunds: map[string]*refund{}, payouts: map[string]*payout{},
		batchIDs: map[string]bool{}, created: map[string]int{}}
}

// Created reports how many resources of a kind were created: "orders",
// "captures", "authorizations", "refunds" or "payouts".
func (s *Server) Created(kind string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.created[kind]
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/__mock/stats" {
		s.mu.Lock()
		defer s.mu.Unlock()
		writeJSON(w, http.StatusOK, map[string]any{"created": s.created})
		return
	}
	if r.Method == http.MethodPost && r.URL.Path == "/v1/oauth2/token" {
		s.token(w, r)
		return
	}
	client, ok := s.authenticate(r)
	if !ok {
		writeJSON(w, http.StatusUnauthorized, map[string]string{
			"error": "invalid_token", "error_description": "Token signature verification failed"})
		return
	}
	p := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	switch {
	case r.Method == http.MethodGet:
		s.show(w, p)
	case r.Method == http.MethodPost:
		s.post(w, r, client, p)
	default:
		notFound(w)
	}
}

func (s *Server) authenticate(r *http.Request) (string, bool) {
	auth := r.Header.Get("Authorization")
	if !strings.HasPrefix(auth, "Bearer ") {
		return "", false
	}
	tok := strings.TrimSpace(strings.TrimPrefix(auth, "Bearer "))
	if tok == "" {
		return "", false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if c, ok := s.tokens[tok]; ok {
		return c, true
	}
	return tok, !s.opt.StrictTokens
}

func (s *Server) token(w http.ResponseWriter, r *http.Request) {
	id, secret, ok := r.BasicAuth()
	if !ok || id == "" || secret == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{
			"error": "invalid_client", "error_description": "Client Authentication failed"})
		return
	}
	_ = r.ParseForm()
	if r.PostForm.Get("grant_type") != "client_credentials" {
		writeJSON(w, http.StatusBadRequest, map[string]string{
			"error": "unsupported_grant_type", "error_description": "Grant Type is NULL"})
		return
	}
	tok := "A21AA" + randAlnum(40)
	s.mu.Lock()
	s.tokens[tok] = id
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{
		"scope": "https://uri.paypal.com/services/payments/payment", "access_token": tok,
		"token_type": "Bearer", "app_id": "APP-MOCK", "expires_in": 32400, "nonce": randAlnum(20)})
}

func (s *Server) show(w http.ResponseWriter, p []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var v any
	switch {
	case len(p) == 4 && p[0] == "v2" && p[1] == "checkout" && p[2] == "orders":
		if o, ok := s.orders[p[3]]; ok {
			v = o
		}
	case len(p) == 4 && p[0] == "v2" && p[1] == "payments" && p[2] == "authorizations":
		if a, ok := s.auths[p[3]]; ok {
			v = a
		}
	case len(p) == 4 && p[0] == "v2" && p[1] == "payments" && p[2] == "captures":
		if c, ok := s.captures[p[3]]; ok {
			v = c
		}
	case len(p) == 4 && p[0] == "v2" && p[1] == "payments" && p[2] == "refunds":
		if rf, ok := s.refunds[p[3]]; ok {
			v = rf
		}
	case len(p) == 4 && p[0] == "v1" && p[1] == "payments" && p[2] == "payouts":
		if po, ok := s.payouts[p[3]]; ok {
			v = po
		}
	default:
		notFound(w)
		return
	}
	if v == nil {
		paypalErr(w, http.StatusNotFound, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID", "Specified resource ID does not exist.")
		return
	}
	writeJSON(w, http.StatusOK, v)
}

// operation is one money-moving POST. execute runs with s.mu held and returns
// the resource kind and id it produced, or writes an error and returns ok=false.
type operation struct {
	status  int
	execute func(body []byte) (kind, id string, errStatus int, errBody any)
}

func (s *Server) route(p []string) (operation, bool) {
	switch {
	case len(p) == 3 && p[0] == "v2" && p[1] == "checkout" && p[2] == "orders":
		return operation{status: http.StatusCreated, execute: s.createOrder}, true
	case len(p) == 5 && p[0] == "v2" && p[1] == "checkout" && p[2] == "orders" && p[4] == "capture":
		id := p[3]
		return operation{status: http.StatusCreated, execute: func([]byte) (string, string, int, any) { return s.captureOrder(id) }}, true
	case len(p) == 5 && p[0] == "v2" && p[1] == "checkout" && p[2] == "orders" && p[4] == "authorize":
		id := p[3]
		return operation{status: http.StatusOK, execute: func([]byte) (string, string, int, any) { return s.authorizeOrder(id) }}, true
	case len(p) == 5 && p[0] == "v2" && p[1] == "payments" && p[2] == "authorizations" && p[4] == "capture":
		id := p[3]
		return operation{status: http.StatusCreated, execute: func([]byte) (string, string, int, any) { return s.captureAuthorization(id) }}, true
	case len(p) == 5 && p[0] == "v2" && p[1] == "payments" && p[2] == "captures" && p[4] == "refund":
		id := p[3]
		return operation{status: http.StatusCreated, execute: func(b []byte) (string, string, int, any) { return s.refundCapture(id, b) }}, true
	case len(p) == 3 && p[0] == "v1" && p[1] == "payments" && p[2] == "payouts":
		return operation{status: http.StatusCreated, execute: s.createPayout}, true
	}
	return operation{}, false
}

func (s *Server) post(w http.ResponseWriter, r *http.Request, client string, p []string) {
	op, ok := s.route(p)
	if !ok {
		notFound(w)
		return
	}
	body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	reqID := r.Header.Get("PayPal-Request-Id")
	cacheKey := client + "|" + reqID

	s.mu.Lock()
	defer s.mu.Unlock()

	if reqID != "" {
		if s.inflight[cacheKey] {
			// Documented: of two simultaneous requests with one id the
			// second "might fail". The status is a guess; see the build plan.
			paypalErr(w, http.StatusConflict, "RESOURCE_CONFLICT", "DUPLICATE_REQUEST_ID",
				"A request with this PayPal-Request-Id is still being processed.")
			return
		}
		if m, ok := s.reqIDs[cacheKey]; ok {
			if s.opt.RequestIDTTL > 0 && s.now().Sub(m.at) > s.opt.RequestIDTTL {
				delete(s.reqIDs, cacheKey)
			} else {
				// PayPal returns the latest status of the earlier request's
				// resource, not a cached copy of its first response.
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(m.status)
				_ = json.NewEncoder(w).Encode(s.current(m.kind, m.id))
				return
			}
		}
		s.inflight[cacheKey] = true
		defer delete(s.inflight, cacheKey)
	}
	if s.opt.ExecDelay > 0 {
		s.mu.Unlock()
		time.Sleep(s.opt.ExecDelay)
		s.mu.Lock()
	}

	kind, id, errStatus, errBody := op.execute(body)
	if errStatus != 0 {
		writeJSON(w, errStatus, errBody)
		return
	}
	s.created[kind]++
	s.attempts++
	if reqID != "" {
		s.reqIDs[cacheKey] = remembered{kind: kind, id: id, status: op.status, at: s.now()}
	}
	if s.opt.ServerErrorEvery > 0 && s.attempts%s.opt.ServerErrorEvery == 0 {
		// The resource exists, but the caller is told the request failed.
		paypalErr(w, http.StatusInternalServerError, "INTERNAL_SERVER_ERROR", "",
			"mock: internal error after the resource was created")
		return
	}
	writeJSON(w, op.status, s.current(kind, id))
}

func (s *Server) current(kind, id string) any {
	switch kind {
	case "orders":
		return s.orders[id]
	case "authorizations":
		return s.authOrd[id]
	case "captures":
		if o := s.orderOfCapture(id); o != nil {
			return o
		}
		return s.captures[id]
	case "refunds":
		return s.refunds[id]
	case "payouts":
		return s.payouts[id]
	}
	return nil
}

func (s *Server) orderOfCapture(captureID string) *order {
	for _, o := range s.orders {
		for _, pu := range o.PurchaseUnits {
			if pu.Payments == nil {
				continue
			}
			for _, c := range pu.Payments.Captures {
				if c.ID == captureID {
					return o
				}
			}
		}
	}
	return nil
}

func (s *Server) createOrder(body []byte) (string, string, int, any) {
	var req struct {
		Intent        string          `json:"intent"`
		PurchaseUnits []purchaseUnit  `json:"purchase_units"`
		PaymentSource json.RawMessage `json:"payment_source"`
	}
	if err := json.Unmarshal(body, &req); err != nil {
		return "", "", http.StatusBadRequest, errBody("INVALID_REQUEST", "MALFORMED_REQUEST_JSON", "The request JSON is not well formed.")
	}
	if req.Intent != "CAPTURE" && req.Intent != "AUTHORIZE" {
		return "", "", http.StatusBadRequest, errBody("INVALID_REQUEST", "INVALID_PARAMETER_VALUE", "intent must be CAPTURE or AUTHORIZE.")
	}
	if len(req.PurchaseUnits) == 0 {
		return "", "", http.StatusBadRequest, errBody("INVALID_REQUEST", "MISSING_REQUIRED_PARAMETER", "purchase_units is required.")
	}
	o := &order{ID: orderID(), Intent: req.Intent, Status: "CREATED", CreateTime: s.stamp()}
	for i := range req.PurchaseUnits {
		pu := req.PurchaseUnits[i]
		if _, err := cents(pu.Amount.Value); err != nil || pu.Amount.CurrencyCode == "" {
			return "", "", http.StatusBadRequest, errBody("INVALID_REQUEST", "INVALID_PARAMETER_VALUE", "amount.value and amount.currency_code are required.")
		}
		if pu.ReferenceID == "" {
			pu.ReferenceID = "default"
		}
		pu.Payments = nil
		o.PurchaseUnits = append(o.PurchaseUnits, &pu)
	}
	// A real order needs buyer approval before capture. An order created
	// with a payment_source is approved straight away in the mock, so
	// demos can capture without a browser.
	if len(req.PaymentSource) > 0 && string(req.PaymentSource) != "null" {
		o.Status = "APPROVED"
	}
	o.Links = []link{{Href: "/v2/checkout/orders/" + o.ID, Rel: "self", Method: "GET"}}
	s.orders[o.ID] = o
	return "orders", o.ID, 0, nil
}

func (s *Server) captureOrder(id string) (string, string, int, any) {
	o, ok := s.orders[id]
	if !ok {
		return "", "", http.StatusNotFound, errBody("RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID", "Specified resource ID does not exist.")
	}
	if o.Intent != "CAPTURE" {
		return "", "", http.StatusUnprocessableEntity, errBody("UNPROCESSABLE_ENTITY", "ACTION_DOES_NOT_MATCH_INTENT", "Order was created with an intent of AUTHORIZE.")
	}
	switch o.Status {
	case "COMPLETED":
		return "", "", http.StatusUnprocessableEntity, errBody("UNPROCESSABLE_ENTITY", "ORDER_ALREADY_CAPTURED", "Order already captured. If 'intent=CAPTURE' only one capture per order is allowed.")
	case "CREATED":
		return "", "", http.StatusUnprocessableEntity, errBody("UNPROCESSABLE_ENTITY", "ORDER_NOT_APPROVED", "Payer has not yet approved the Order for payment.")
	}
	var last string
	for _, pu := range o.PurchaseUnits {
		total, _ := cents(pu.Amount.Value)
		c := &capture{ID: paymentID(), Status: "COMPLETED", Amount: pu.Amount, FinalCapture: true, CreateTime: s.stamp(), total: total}
		c.Links = []link{{Href: "/v2/payments/captures/" + c.ID, Rel: "self", Method: "GET"},
			{Href: "/v2/payments/captures/" + c.ID + "/refund", Rel: "refund", Method: "POST"}}
		pu.Payments = &unitPayments{Captures: []*capture{c}}
		s.captures[c.ID] = c
		last = c.ID
	}
	o.Status = "COMPLETED"
	return "captures", last, 0, nil
}

func (s *Server) authorizeOrder(id string) (string, string, int, any) {
	o, ok := s.orders[id]
	if !ok {
		return "", "", http.StatusNotFound, errBody("RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID", "Specified resource ID does not exist.")
	}
	if o.Intent != "AUTHORIZE" {
		return "", "", http.StatusUnprocessableEntity, errBody("UNPROCESSABLE_ENTITY", "ACTION_DOES_NOT_MATCH_INTENT", "Order was created with an intent of CAPTURE.")
	}
	switch o.Status {
	case "COMPLETED":
		return "", "", http.StatusUnprocessableEntity, errBody("UNPROCESSABLE_ENTITY", "ORDER_ALREADY_AUTHORIZED", "Order already authorized.")
	case "CREATED":
		return "", "", http.StatusUnprocessableEntity, errBody("UNPROCESSABLE_ENTITY", "ORDER_NOT_APPROVED", "Payer has not yet approved the Order for payment.")
	}
	var last string
	for _, pu := range o.PurchaseUnits {
		a := &authorization{ID: paymentID(), Status: "CREATED", Amount: pu.Amount, CreateTime: s.stamp()}
		a.Links = []link{{Href: "/v2/payments/authorizations/" + a.ID, Rel: "self", Method: "GET"},
			{Href: "/v2/payments/authorizations/" + a.ID + "/capture", Rel: "capture", Method: "POST"}}
		pu.Payments = &unitPayments{Authorizations: []*authorization{a}}
		s.auths[a.ID] = a
		s.authOrd[a.ID] = o
		last = a.ID
	}
	o.Status = "COMPLETED"
	return "authorizations", last, 0, nil
}

// captureAuthorization models a final capture only; PayPal also supports
// multiple partial captures, which the mock does not.
func (s *Server) captureAuthorization(id string) (string, string, int, any) {
	a, ok := s.auths[id]
	if !ok {
		return "", "", http.StatusNotFound, errBody("RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID", "Specified resource ID does not exist.")
	}
	if a.Status == "CAPTURED" {
		return "", "", http.StatusUnprocessableEntity, errBody("UNPROCESSABLE_ENTITY", "AUTHORIZATION_ALREADY_CAPTURED", "Authorization has been previously captured and hence cannot be captured again.")
	}
	total, _ := cents(a.Amount.Value)
	c := &capture{ID: paymentID(), Status: "COMPLETED", Amount: a.Amount, FinalCapture: true, CreateTime: s.stamp(), total: total}
	c.Links = []link{{Href: "/v2/payments/captures/" + c.ID, Rel: "self", Method: "GET"}}
	s.captures[c.ID] = c
	a.Status = "CAPTURED"
	return "captures", c.ID, 0, nil
}

// refundCapture allows any number of partial refunds until the captured
// amount is used up, which is the case the build plan expects to be PayPal's
// clearest double-money risk (to verify in the sandbox).
func (s *Server) refundCapture(id string, body []byte) (string, string, int, any) {
	c, ok := s.captures[id]
	if !ok {
		return "", "", http.StatusNotFound, errBody("RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID", "Specified resource ID does not exist.")
	}
	var req struct {
		Amount *money `json:"amount"`
	}
	if len(strings.TrimSpace(string(body))) > 0 {
		if err := json.Unmarshal(body, &req); err != nil {
			return "", "", http.StatusBadRequest, errBody("INVALID_REQUEST", "MALFORMED_REQUEST_JSON", "The request JSON is not well formed.")
		}
	}
	remaining := c.total - c.refunded
	if remaining <= 0 {
		return "", "", http.StatusUnprocessableEntity, errBody("UNPROCESSABLE_ENTITY", "CAPTURE_FULLY_REFUNDED", "The capture has already been fully refunded.")
	}
	amt := money{CurrencyCode: c.Amount.CurrencyCode, Value: formatCents(remaining)}
	want := remaining
	if req.Amount != nil {
		v, err := cents(req.Amount.Value)
		if err != nil || v <= 0 {
			return "", "", http.StatusBadRequest, errBody("INVALID_REQUEST", "INVALID_PARAMETER_VALUE", "amount.value is invalid.")
		}
		if v > remaining {
			return "", "", http.StatusUnprocessableEntity, errBody("UNPROCESSABLE_ENTITY", "REFUND_AMOUNT_EXCEEDED", "The refund amount must be less than or equal to the capture amount that has not yet been refunded.")
		}
		want = v
		amt = money{CurrencyCode: c.Amount.CurrencyCode, Value: formatCents(v)}
	}
	c.refunded += want
	if c.refunded >= c.total {
		c.Status = "REFUNDED"
	} else {
		c.Status = "PARTIALLY_REFUNDED"
	}
	rf := &refund{ID: paymentID(), Status: "COMPLETED", Amount: amt, CreateTime: s.stamp()}
	rf.Links = []link{{Href: "/v2/payments/refunds/" + rf.ID, Rel: "self", Method: "GET"},
		{Href: "/v2/payments/captures/" + c.ID, Rel: "up", Method: "GET"}}
	s.refunds[rf.ID] = rf
	return "refunds", rf.ID, 0, nil
}

func (s *Server) createPayout(body []byte) (string, string, int, any) {
	var req struct {
		SenderBatchHeader json.RawMessage   `json:"sender_batch_header"`
		Items             []json.RawMessage `json:"items"`
	}
	if err := json.Unmarshal(body, &req); err != nil || len(req.Items) == 0 || len(req.SenderBatchHeader) == 0 {
		return "", "", http.StatusBadRequest, errBody("VALIDATION_ERROR", "MISSING_REQUIRED_PARAMETER", "sender_batch_header and items are required.")
	}
	var hdr struct {
		SenderBatchID string `json:"sender_batch_id"`
	}
	_ = json.Unmarshal(req.SenderBatchHeader, &hdr)
	if hdr.SenderBatchID != "" {
		// PayPal rejects a reused sender_batch_id, which protects payouts
		// even without PayPal-Request-Id when clients set it per batch.
		if s.batchIDs[hdr.SenderBatchID] {
			return "", "", http.StatusBadRequest, map[string]any{"name": "USER_BUSINESS_ERROR",
				"message": "Batch with given sender_batch_id already exists", "debug_id": debugID()}
		}
		s.batchIDs[hdr.SenderBatchID] = true
	}
	po := &payout{}
	po.BatchHeader.PayoutBatchID = strings.ToUpper(randAlnum(13))
	po.BatchHeader.BatchStatus = "PENDING"
	po.BatchHeader.SenderBatchHeader = req.SenderBatchHeader
	po.Links = []link{{Href: "/v1/payments/payouts/" + po.BatchHeader.PayoutBatchID, Rel: "self", Method: "GET"}}
	s.payouts[po.BatchHeader.PayoutBatchID] = po
	return "payouts", po.BatchHeader.PayoutBatchID, 0, nil
}

func (s *Server) stamp() string { return s.now().UTC().Format(time.RFC3339) }

// cents parses a PayPal decimal string ("10.00") into cents.
func cents(v string) (float64, error) {
	f, err := strconv.ParseFloat(v, 64)
	if err != nil || f < 0 {
		return 0, fmt.Errorf("bad amount %q", v)
	}
	return float64(int64(f*100 + 0.5)), nil
}

func formatCents(c float64) string { return fmt.Sprintf("%.2f", c/100) }

const alnum = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

func randAlnum(n int) string {
	b := make([]byte, n)
	max := big.NewInt(int64(len(alnum)))
	for i := range b {
		x, _ := rand.Int(rand.Reader, max)
		b[i] = alnum[x.Int64()]
	}
	return string(b)
}

func orderID() string   { return randAlnum(17) }
func paymentID() string { return randAlnum(17) }
func debugID() string   { return strings.ToLower(randAlnum(13)) }

func errBody(name, issue, desc string) map[string]any {
	return map[string]any{"name": name, "message": desc, "debug_id": debugID(),
		"details": []map[string]string{{"issue": issue, "description": desc}}}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func paypalErr(w http.ResponseWriter, status int, name, issue, msg string) {
	b := map[string]any{"name": name, "message": msg, "debug_id": debugID()}
	if issue != "" {
		b["details"] = []map[string]string{{"issue": issue, "description": msg}}
	}
	writeJSON(w, status, b)
}

func notFound(w http.ResponseWriter) {
	paypalErr(w, http.StatusNotFound, "RESOURCE_NOT_FOUND", "", "The requested resource was not found.")
}
