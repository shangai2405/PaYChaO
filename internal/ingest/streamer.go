// Package ingest streams a run's events from the engine to the paychaos API.
//
// Two rules shape it:
//
//   - The proxy path never waits on the API. Enqueue never blocks: events go
//     into a bounded in-memory queue, and once the queue is full they are
//     appended to a local NDJSON spill file instead. A slow or absent
//     dashboard cannot change fault timing.
//   - Ingest is retry-safe. Events are sent in numbered batches; the API
//     stores (run_id, seq) uniquely and ignores a batch it already has, so a
//     batch whose response was lost can be sent again. The run itself is
//     created with an idempotent PUT keyed by a run id the engine generates.
//
// Secrets never reach the API: records carry no Authorization header, no
// token and no client secret, only the short account hash the auditor uses.
package ingest

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/shangai2405/paychaos/internal/audit"
	"github.com/shangai2405/paychaos/internal/webhook"
)

// Event is one item in a batch. Exactly one payload field is set.
type Event struct {
	Kind    string            `json:"kind"` // "request", "finding" or "webhook"
	At      time.Time         `json:"at"`
	Request *audit.Record     `json:"request,omitempty"`
	Finding *audit.Finding    `json:"finding,omitempty"`
	Webhook *webhook.Delivery `json:"webhook,omitempty"`
}

// RunMeta is sent once, when the run starts.
type RunMeta struct {
	Name      string          `json:"name,omitempty"`
	Seed      uint64          `json:"seed"`
	Upstream  string          `json:"upstream"`
	Scenario  json.RawMessage `json:"scenario"`
	StartedAt time.Time       `json:"started_at"`
	Version   string          `json:"engine_version"`
	// ScenarioName and ScenarioVersion are set when the scenario was loaded
	// by name from the API (-scenario).
	ScenarioName    string `json:"scenario_name,omitempty"`
	ScenarioVersion int    `json:"scenario_version,omitempty"`
	// CI describes where the run came from (paychaos ci).
	CI *CI `json:"ci,omitempty"`
}

// CI is what a CI system tells us about the code under test.
type CI struct {
	Provider      string `json:"provider"`
	Repo          string `json:"repo,omitempty"`
	Branch        string `json:"branch,omitempty"`
	Commit        string `json:"commit,omitempty"`
	PRNumber      int    `json:"pr_number,omitempty"`
	BaseBranch    string `json:"base_branch,omitempty"`
	DefaultBranch string `json:"default_branch,omitempty"`
	URL           string `json:"url,omitempty"`
}

// Finish is sent once, when the run ends. Its findings replace any streamed
// so far, because some findings (lost responses never retried) can only be
// decided once traffic has stopped.
type Finish struct {
	FinishedAt    time.Time              `json:"finished_at"`
	Findings      []audit.Finding        `json:"findings"`
	FaultsApplied map[string]int         `json:"faults_applied"`
	Webhooks      []webhook.EventSummary `json:"webhooks"`
	WebhookNotes  []string               `json:"webhook_notes"`
	RequestCount  int                    `json:"request_count"`
}

// Options configures a Streamer.
type Options struct {
	BaseURL    string // e.g. http://127.0.0.1:3000
	Token      string // project ingest token
	RunID      string // defaults to a random UUID
	QueueSize  int    // default 10000
	BatchSize  int    // default 200
	FlushEvery time.Duration
	SpillPath  string // default paychaos-spill-<run>.ndjson
	Client     *http.Client
	Logger     *slog.Logger
	// MaxBackoff caps the delay between retries of one batch.
	MaxBackoff time.Duration
}

// Stats summarises what happened to the run's events.
type Stats struct {
	Sent    int `json:"sent"`
	Batches int `json:"batches"`
	Spilled int `json:"spilled"`
}

// Streamer sends events in the background. Create with New, call Start once,
// Enqueue from any goroutine, and Close at the end.
type Streamer struct {
	opt   Options
	queue chan Event
	done  chan struct{}
	quit  chan struct{}

	mu        sync.Mutex
	stats     Stats
	spill     *os.File
	closed    bool
	started   bool
	meta      RunMeta
	nextSeq   int
	closeOnce sync.Once
}

// NewRunID returns a random version 4 UUID.
func NewRunID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// New validates options and returns a streamer that has not started sending.
func New(opt Options) (*Streamer, error) {
	if opt.BaseURL == "" || opt.Token == "" {
		return nil, errors.New("ingest: base URL and token are required")
	}
	opt.BaseURL = strings.TrimSuffix(opt.BaseURL, "/")
	if opt.RunID == "" {
		opt.RunID = NewRunID()
	}
	if opt.QueueSize <= 0 {
		opt.QueueSize = 10000
	}
	if opt.BatchSize <= 0 {
		opt.BatchSize = 200
	}
	if opt.FlushEvery <= 0 {
		opt.FlushEvery = 500 * time.Millisecond
	}
	if opt.MaxBackoff <= 0 {
		opt.MaxBackoff = 5 * time.Second
	}
	if opt.SpillPath == "" {
		opt.SpillPath = "paychaos-spill-" + opt.RunID + ".ndjson"
	}
	if opt.Client == nil {
		opt.Client = &http.Client{Timeout: 10 * time.Second}
	}
	if opt.Logger == nil {
		opt.Logger = slog.New(slog.NewTextHandler(io.Discard, nil))
	}
	return &Streamer{opt: opt, queue: make(chan Event, opt.QueueSize), done: make(chan struct{}), quit: make(chan struct{}), nextSeq: 1}, nil
}

// RunID is the id this run is stored under.
func (s *Streamer) RunID() string { return s.opt.RunID }

// SpillPath is where events that could not be queued or sent are written.
func (s *Streamer) SpillPath() string { return s.opt.SpillPath }

// Start begins sending in the background. The run is registered by the same
// goroutine before the first batch, with retries, so Start never blocks.
func (s *Streamer) Start(meta RunMeta) {
	s.mu.Lock()
	if s.started {
		s.mu.Unlock()
		return
	}
	s.started = true
	s.meta = meta
	s.mu.Unlock()
	go s.loop()
}

// Enqueue adds an event without blocking. When the queue is full the event is
// written to the spill file instead.
func (s *Streamer) Enqueue(ev Event) {
	if ev.At.IsZero() {
		ev.At = time.Now().UTC()
	}
	s.mu.Lock()
	closed := s.closed
	s.mu.Unlock()
	if closed {
		s.spillEvents([]Event{ev})
		return
	}
	select {
	case s.queue <- ev:
	default:
		s.spillEvents([]Event{ev})
	}
}

// Hooks returns auditor hooks that enqueue records and findings.
func (s *Streamer) Hooks() audit.Hooks {
	return audit.Hooks{
		OnRecord:  func(r audit.Record) { s.Enqueue(Event{Kind: "request", Request: &r}) },
		OnFinding: func(f audit.Finding) { s.Enqueue(Event{Kind: "finding", Finding: &f}) },
	}
}

// OnDelivery is a webhook relay callback that enqueues a delivery.
func (s *Streamer) OnDelivery(d webhook.Delivery) {
	s.Enqueue(Event{Kind: "webhook", Webhook: &d})
}

func (s *Streamer) loop() {
	defer close(s.done)
	if !s.retry(func() error { return s.put("/api/ingest/runs/"+s.opt.RunID, s.meta) }) {
		s.drainToSpill()
		return
	}
	tick := time.NewTicker(s.opt.FlushEvery)
	defer tick.Stop()
	var batch []Event
	flush := func() bool {
		if len(batch) == 0 {
			return true
		}
		ok := s.sendBatch(batch)
		batch = nil
		return ok
	}
	for {
		select {
		case ev := <-s.queue:
			batch = append(batch, ev)
			if len(batch) >= s.opt.BatchSize && !flush() {
				s.drainToSpill()
				return
			}
		case <-tick.C:
			if !flush() {
				s.drainToSpill()
				return
			}
		case <-s.quit:
			for {
				select {
				case ev := <-s.queue:
					batch = append(batch, ev)
					if len(batch) >= s.opt.BatchSize && !flush() {
						s.drainToSpill()
						return
					}
				default:
					if !flush() {
						s.drainToSpill()
					}
					return
				}
			}
		}
	}
}

func (s *Streamer) sendBatch(batch []Event) bool {
	s.mu.Lock()
	seq := s.nextSeq
	s.nextSeq++
	s.mu.Unlock()
	body := map[string]any{"seq": seq, "events": batch}
	ok := s.retry(func() error { return s.post(fmt.Sprintf("/api/ingest/runs/%s/batches", s.opt.RunID), body) })
	if !ok {
		s.spillEvents(batch)
		return false
	}
	s.mu.Lock()
	s.stats.Sent += len(batch)
	s.stats.Batches++
	s.mu.Unlock()
	return true
}

// retry calls f with capped exponential backoff until it succeeds, a
// non-retryable error occurs, or Close's deadline passes (quit closed and the
// retry budget after quit exhausted).
func (s *Streamer) retry(f func() error) bool {
	backoff := 100 * time.Millisecond
	afterQuit := 0
	for {
		err := f()
		if err == nil {
			return true
		}
		var perm permanentError
		if errors.As(err, &perm) {
			s.opt.Logger.Error("ingest rejected", "err", err)
			return false
		}
		s.opt.Logger.Warn("ingest failed; retrying", "err", err, "in", backoff)
		select {
		case <-time.After(backoff):
		case <-s.quit:
			// Shutting down: a few quick retries, then give up and spill.
			afterQuit++
			if afterQuit > 3 {
				return false
			}
			time.Sleep(backoff)
		}
		if backoff *= 2; backoff > s.opt.MaxBackoff {
			backoff = s.opt.MaxBackoff
		}
	}
}

type permanentError struct{ error }

func (s *Streamer) put(path string, body any) error  { return s.send(http.MethodPut, path, body) }
func (s *Streamer) post(path string, body any) error { return s.send(http.MethodPost, path, body) }

func (s *Streamer) send(method, path string, body any) error {
	b, err := json.Marshal(body)
	if err != nil {
		return permanentError{err}
	}
	req, err := http.NewRequest(method, s.opt.BaseURL+path, bytes.NewReader(b))
	if err != nil {
		return permanentError{err}
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+s.opt.Token)
	resp, err := s.opt.Client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	msg, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
	switch {
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		return nil
	case resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500:
		return fmt.Errorf("%s %s: %d %s", method, path, resp.StatusCode, msg)
	default:
		return permanentError{fmt.Errorf("%s %s: %d %s", method, path, resp.StatusCode, msg)}
	}
}

func (s *Streamer) drainToSpill() {
	var rest []Event
	for {
		select {
		case ev := <-s.queue:
			rest = append(rest, ev)
		default:
			s.spillEvents(rest)
			return
		}
	}
}

func (s *Streamer) spillEvents(evs []Event) {
	if len(evs) == 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.openSpill() {
		s.opt.Logger.Error("cannot open spill file; events dropped", "count", len(evs))
		return
	}
	enc := json.NewEncoder(s.spill)
	for i := range evs {
		if enc.Encode(evs[i]) == nil {
			s.stats.Spilled++
		}
	}
}

// openSpill opens the spill file on first use and writes its header line:
// the run's id and metadata, so the file can be uploaded later on its own
// (see UploadSpill). Called with s.mu held.
func (s *Streamer) openSpill() bool {
	if s.spill != nil {
		return true
	}
	f, err := os.OpenFile(s.opt.SpillPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		s.opt.Logger.Error("cannot open spill file", "err", err)
		return false
	}
	s.spill = f
	meta := s.meta
	_ = json.NewEncoder(f).Encode(spillLine{Kind: "run", RunID: s.opt.RunID, Run: &meta})
	return true
}

// Close stops accepting events, sends what is queued and the finish message,
// and waits until ctx is done at the latest. Events that could not be sent
// are in the spill file.
func (s *Streamer) Close(ctx context.Context, fin Finish) (Stats, error) {
	var err error
	s.closeOnce.Do(func() {
		s.mu.Lock()
		s.closed = true
		started := s.started
		s.mu.Unlock()
		if !started {
			close(s.done)
		}
		close(s.quit)
		select {
		case <-s.done:
		case <-ctx.Done():
			err = ctx.Err()
		}
		if err == nil {
			if e := s.post("/api/ingest/runs/"+s.opt.RunID+"/finish", fin); e != nil {
				// One more attempt: finish is idempotent.
				if e2 := s.post("/api/ingest/runs/"+s.opt.RunID+"/finish", fin); e2 != nil {
					err = e2
				}
			}
		}
		s.mu.Lock()
		// Whatever did not reach the API is in the spill file; add the
		// finish so a later upload (UploadSpill) can complete the run.
		if (s.spill != nil || err != nil) && started && s.openSpill() {
			_ = json.NewEncoder(s.spill).Encode(spillLine{Kind: "finish", RunID: s.opt.RunID, Finish: &fin})
		}
		if s.spill != nil {
			_ = s.spill.Close()
		}
		s.mu.Unlock()
	})
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.stats, err
}
