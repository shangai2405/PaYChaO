package webhook

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/shangai2405/paychaos/internal/chaos"
)

type target struct {
	mu   sync.Mutex
	ids  []string
	sigs []string
}

func (t *target) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	b, _ := io.ReadAll(r.Body)
	var ev struct{ ID string }
	_ = json.Unmarshal(b, &ev)
	t.mu.Lock()
	t.ids = append(t.ids, ev.ID)
	t.sigs = append(t.sigs, r.Header.Get("Paypal-Transmission-Sig"))
	t.mu.Unlock()
}

func send(t *testing.T, url, id string) {
	t.Helper()
	body := fmt.Sprintf(`{"id":%q,"event_type":"PAYMENT.CAPTURE.COMPLETED"}`, id)
	req, _ := http.NewRequest(http.MethodPost, url, bytes.NewBufferString(body))
	req.Header.Set("PAYPAL-TRANSMISSION-SIG", "sig-"+id)
	resp, err := http.DefaultClient.Do(req)
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("relay did not ack: %v", err)
	}
	resp.Body.Close()
}

func TestDuplicatesKeepSignature(t *testing.T) {
	tg := &target{}
	ts := httptest.NewServer(tg)
	defer ts.Close()
	eng := chaos.NewStream(1, chaos.StreamWebhooks)
	r := New(ts.URL, chaos.WebhookRules{DuplicateProbability: 1, DuplicateCount: 2}, eng, nil)
	rs := httptest.NewServer(r)
	defer rs.Close()

	send(t, rs.URL, "evt_1")
	r.Close()

	if len(tg.ids) != 3 {
		t.Fatalf("target got %d deliveries, want 3", len(tg.ids))
	}
	for _, s := range tg.sigs {
		if s != "sig-evt_1" {
			t.Fatalf("signature not forwarded: %q", s)
		}
	}
	sums := r.Summaries()
	if len(sums) != 1 || sums[0].Deliveries != 3 || sums[0].Accepted != 3 {
		t.Fatalf("bad summary %+v", sums)
	}
	if len(Notes(sums)) == 0 {
		t.Fatal("expected a duplicate-delivery note")
	}
}

func TestReorderDeliversEveryEvent(t *testing.T) {
	tg := &target{}
	ts := httptest.NewServer(tg)
	defer ts.Close()
	eng := chaos.NewStream(3, chaos.StreamWebhooks)
	r := New(ts.URL, chaos.WebhookRules{ReorderWindowMS: 60_000}, eng, nil) // flushed only on Close
	rs := httptest.NewServer(r)
	defer rs.Close()

	want := map[string]bool{}
	for i := 0; i < 20; i++ {
		id := fmt.Sprintf("evt_%02d", i)
		want[id] = true
		send(t, rs.URL, id)
	}
	r.Close()

	if len(tg.ids) != 20 {
		t.Fatalf("got %d deliveries want 20", len(tg.ids))
	}
	inOrder := true
	for i, id := range tg.ids {
		delete(want, id)
		if id != fmt.Sprintf("evt_%02d", i) {
			inOrder = false
		}
	}
	if len(want) != 0 {
		t.Fatalf("events lost: %v", want)
	}
	if inOrder {
		t.Fatal("20 events delivered in original order; shuffle had no effect")
	}
	reordered := 0
	for _, s := range r.Summaries() {
		if s.Reordered {
			reordered++
		}
	}
	if reordered == 0 {
		t.Fatal("summaries report no reordering")
	}
}

func TestForwardsEveryPayPalHeaderAndRawBody(t *testing.T) {
	var got http.Header
	var gotBody []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Clone()
		gotBody, _ = io.ReadAll(r.Body)
	}))
	defer srv.Close()
	r := New(srv.URL, chaos.WebhookRules{}, chaos.NewStream(1, chaos.StreamWebhooks), nil)
	raw := "{\"id\":\"WH-1\",  \"event_type\":\"PAYMENT.CAPTURE.COMPLETED\"}"
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(raw))
	for k, v := range map[string]string{
		"PAYPAL-TRANSMISSION-ID": "tid", "PAYPAL-TRANSMISSION-TIME": "2026-11-10T00:00:00Z",
		"PAYPAL-TRANSMISSION-SIG": "sig", "PAYPAL-CERT-URL": "https://api.sandbox.paypal.com/cert", "PAYPAL-AUTH-ALGO": "SHA256withRSA",
		"Content-Type": "application/json", "X-Other": "dropped",
	} {
		req.Header.Set(k, v)
	}
	r.ServeHTTP(httptest.NewRecorder(), req)
	r.Close()
	for _, h := range []string{"Paypal-Transmission-Id", "Paypal-Transmission-Time", "Paypal-Transmission-Sig", "Paypal-Cert-Url", "Paypal-Auth-Algo"} {
		if got.Get(h) == "" {
			t.Errorf("%s not forwarded", h)
		}
	}
	if got.Get("X-Other") != "" {
		t.Error("unrelated header forwarded")
	}
	if string(gotBody) != raw {
		t.Fatalf("body changed: %q", gotBody)
	}
	if s := r.Summaries(); len(s) != 1 || s[0].Type != "PAYMENT.CAPTURE.COMPLETED" || s[0].EventID != "WH-1" {
		t.Fatalf("summary %+v", s)
	}
}
