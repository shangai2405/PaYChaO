package ingest

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/shangai2405/paychaos/internal/audit"
)

type fakeAPI struct {
	mu        sync.Mutex
	runs      map[string]RunMeta
	batches   map[int][]Event // seq -> events, stored once
	attempts  map[int]int
	finished  *Finish
	failFirst bool // answer 500 to the first attempt of each batch, after storing it
	tokens    []string
}

func newFakeAPI() *fakeAPI {
	return &fakeAPI{runs: map[string]RunMeta{}, batches: map[int][]Event{}, attempts: map[int]int{}}
}

func (f *fakeAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.tokens = append(f.tokens, r.Header.Get("Authorization"))
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	switch {
	case r.Method == http.MethodPut && len(parts) == 4:
		var m RunMeta
		_ = json.NewDecoder(r.Body).Decode(&m)
		f.runs[parts[3]] = m
	case r.Method == http.MethodPost && len(parts) == 5 && parts[4] == "batches":
		var b struct {
			Seq    int     `json:"seq"`
			Events []Event `json:"events"`
		}
		_ = json.NewDecoder(r.Body).Decode(&b)
		f.attempts[b.Seq]++
		if _, ok := f.batches[b.Seq]; !ok {
			f.batches[b.Seq] = b.Events
		}
		if f.failFirst && f.attempts[b.Seq] == 1 {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
	case r.Method == http.MethodPost && len(parts) == 5 && parts[4] == "finish":
		var fin Finish
		_ = json.NewDecoder(r.Body).Decode(&fin)
		f.finished = &fin
	default:
		w.WriteHeader(http.StatusNotFound)
		return
	}
	w.WriteHeader(http.StatusOK)
}

func (f *fakeAPI) events() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, b := range f.batches {
		n += len(b)
	}
	return n
}

func newStreamer(t *testing.T, url string, mod func(*Options)) *Streamer {
	t.Helper()
	o := Options{BaseURL: url, Token: "pct_test", BatchSize: 10, FlushEvery: 20 * time.Millisecond,
		SpillPath: filepath.Join(t.TempDir(), "spill.ndjson"), MaxBackoff: 20 * time.Millisecond}
	if mod != nil {
		mod(&o)
	}
	s, err := New(o)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestStreamsBatchesAndFinish(t *testing.T) {
	api := newFakeAPI()
	srv := httptest.NewServer(api)
	defer srv.Close()
	s := newStreamer(t, srv.URL, nil)
	s.Start(RunMeta{Seed: 7, Upstream: "mock"})
	for i := 0; i < 35; i++ {
		s.Enqueue(Event{Kind: "request", Request: &audit.Record{Seq: i + 1}})
	}
	st, err := s.Close(context.Background(), Finish{RequestCount: 35})
	if err != nil {
		t.Fatal(err)
	}
	if st.Sent != 35 || st.Spilled != 0 || api.events() != 35 {
		t.Fatalf("stats %+v, api got %d", st, api.events())
	}
	if api.runs[s.RunID()].Seed != 7 || api.finished == nil || api.finished.RequestCount != 35 {
		t.Fatalf("run %+v finish %+v", api.runs, api.finished)
	}
	for _, tok := range api.tokens {
		if tok != "Bearer pct_test" {
			t.Fatalf("token header %q", tok)
		}
	}
}

// A batch whose response is lost is sent again with the same seq, and the API
// stores it once.
func TestLostBatchResponseIsResentWithSameSeq(t *testing.T) {
	api := newFakeAPI()
	api.failFirst = true
	srv := httptest.NewServer(api)
	defer srv.Close()
	s := newStreamer(t, srv.URL, nil)
	s.Start(RunMeta{})
	for i := 0; i < 25; i++ {
		s.Enqueue(Event{Kind: "request", Request: &audit.Record{Seq: i + 1}})
	}
	if _, err := s.Close(context.Background(), Finish{}); err != nil {
		t.Fatal(err)
	}
	if api.events() != 25 {
		t.Fatalf("stored %d events, want 25", api.events())
	}
	for seq, n := range api.attempts {
		if n != 2 {
			t.Fatalf("batch %d sent %d times, want 2", seq, n)
		}
	}
}

// Enqueue never blocks: with a full queue and no API, events spill to disk.
func TestFullQueueSpillsWithoutBlocking(t *testing.T) {
	s := newStreamer(t, "http://127.0.0.1:1", func(o *Options) { o.QueueSize = 5 })
	// Not started, so nothing drains the queue.
	start := time.Now()
	for i := 0; i < 50; i++ {
		s.Enqueue(Event{Kind: "request", Request: &audit.Record{Seq: i + 1}})
	}
	if time.Since(start) > 200*time.Millisecond {
		t.Fatal("Enqueue blocked")
	}
	s.mu.Lock()
	spilled := s.stats.Spilled
	s.mu.Unlock()
	if spilled != 45 {
		t.Fatalf("spilled %d, want 45", spilled)
	}
}

// With the API down for the whole run, everything ends up in the spill file.
func TestAPIDownSpillsEverything(t *testing.T) {
	s := newStreamer(t, "http://127.0.0.1:1", nil)
	s.Start(RunMeta{})
	for i := 0; i < 12; i++ {
		s.Enqueue(Event{Kind: "finding", Finding: &audit.Finding{Code: audit.CodeMissingRequestID}})
	}
	time.Sleep(50 * time.Millisecond)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	st, err := s.Close(ctx, Finish{})
	if err == nil {
		t.Fatal("finish cannot succeed with the API down")
	}
	if st.Spilled != 12 || st.Sent != 0 {
		t.Fatalf("stats %+v", st)
	}
	f, _ := os.Open(s.SpillPath())
	defer f.Close()
	n := 0
	for sc := bufio.NewScanner(f); sc.Scan(); n++ {
		var ev Event
		if json.Unmarshal(sc.Bytes(), &ev) != nil || ev.Kind != "finding" {
			t.Fatalf("bad spill line %q", sc.Text())
		}
	}
	if n != 12 {
		t.Fatalf("spill has %d lines", n)
	}
}

func TestBadTokenIsNotRetriedForever(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
	}))
	defer srv.Close()
	s := newStreamer(t, srv.URL, func(o *Options) { o.MaxBackoff = time.Hour })
	s.Start(RunMeta{})
	s.Enqueue(Event{Kind: "request", Request: &audit.Record{Seq: 1}})
	done := make(chan struct{})
	go func() { _, _ = s.Close(context.Background(), Finish{}); close(done) }()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("a 401 from the API was retried instead of failing fast")
	}
}

func TestNewRunIDIsUUIDv4(t *testing.T) {
	id := NewRunID()
	if len(id) != 36 || id[14] != '4' || strings.Count(id, "-") != 4 {
		t.Fatalf("not a v4 UUID: %s", id)
	}
	if id == NewRunID() {
		t.Fatal("ids repeat")
	}
}

func TestOptionsValidated(t *testing.T) {
	if _, err := New(Options{}); err == nil {
		t.Fatal("missing URL and token accepted")
	}
}
