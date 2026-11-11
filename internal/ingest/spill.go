package ingest

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// spillLine is one line of a spill file. The first line is the run header
// (kind "run"); event lines are Events; a final "finish" line is written
// when the run ended without its finish reaching the API, or with events
// left behind.
type spillLine struct {
	Kind   string   `json:"kind"`
	RunID  string   `json:"run_id,omitempty"`
	Run    *RunMeta `json:"run,omitempty"`
	Finish *Finish  `json:"finish,omitempty"`
}

// spillBatchBase numbers re-uploaded batches far above any live batch, and
// deterministically, so uploading the same file twice stores it once.
const spillBatchBase = 1_000_000

// SpillUpload reports what UploadSpill sent.
type SpillUpload struct {
	RunID    string `json:"run_id"`
	Events   int    `json:"events"`
	Batches  int    `json:"batches"`
	Finished bool   `json:"finished"`
}

// ErrNoSpillHeader means the file has no run header line: it was written by
// a paychaos older than spill uploads, or is not a spill file.
var ErrNoSpillHeader = errors.New("spill file has no run header; it cannot be uploaded")

// UploadSpill sends a spill file's run, events and finish to the API using
// the same idempotent endpoints as live streaming, then deletes the file.
// Uploading a file twice is harmless. When the file has a finish line, the
// finish's findings replace the run's findings, so spilled provisional
// findings are not sent.
func UploadSpill(ctx context.Context, opt Options, path string) (SpillUpload, error) {
	var res SpillUpload
	if opt.BaseURL == "" || opt.Token == "" {
		return res, errors.New("ingest: base URL and token are required")
	}
	opt.BaseURL = strings.TrimSuffix(opt.BaseURL, "/")
	if opt.Client == nil {
		opt.Client = &http.Client{Timeout: 15 * time.Second}
	}
	if opt.BatchSize <= 0 {
		opt.BatchSize = 200
	}
	f, err := os.Open(path)
	if err != nil {
		return res, err
	}
	var (
		header *spillLine
		finish *Finish
		events []Event
	)
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64*1024), 16*1024*1024)
	for line := 1; sc.Scan(); line++ {
		raw := sc.Bytes()
		if len(strings.TrimSpace(string(raw))) == 0 {
			continue
		}
		var probe struct {
			Kind string `json:"kind"`
		}
		if err := json.Unmarshal(raw, &probe); err != nil {
			f.Close()
			return res, fmt.Errorf("%s line %d: %w", path, line, err)
		}
		switch probe.Kind {
		case "run":
			var h spillLine
			if err := json.Unmarshal(raw, &h); err != nil || h.Run == nil || h.RunID == "" {
				f.Close()
				return res, fmt.Errorf("%s line %d: bad run header", path, line)
			}
			header = &h
		case "finish":
			var l spillLine
			if err := json.Unmarshal(raw, &l); err != nil || l.Finish == nil {
				f.Close()
				return res, fmt.Errorf("%s line %d: bad finish line", path, line)
			}
			finish = l.Finish
		default:
			var ev Event
			if err := json.Unmarshal(raw, &ev); err != nil {
				f.Close()
				return res, fmt.Errorf("%s line %d: %w", path, line, err)
			}
			events = append(events, ev)
		}
	}
	err = sc.Err()
	f.Close()
	if err != nil {
		return res, err
	}
	if header == nil {
		return res, ErrNoSpillHeader
	}
	res.RunID = header.RunID
	s := &Streamer{opt: opt}
	if err := s.sendNow(ctx, http.MethodPut, "/api/ingest/runs/"+header.RunID, header.Run); err != nil {
		return res, err
	}
	if finish != nil {
		kept := events[:0]
		for _, ev := range events {
			if ev.Kind != "finding" {
				kept = append(kept, ev)
			}
		}
		events = kept
	}
	for i := 0; i < len(events); i += opt.BatchSize {
		end := min(i+opt.BatchSize, len(events))
		body := map[string]any{"seq": spillBatchBase + i/opt.BatchSize, "events": events[i:end]}
		if err := s.sendNow(ctx, http.MethodPost, fmt.Sprintf("/api/ingest/runs/%s/batches", header.RunID), body); err != nil {
			return res, err
		}
		res.Events += end - i
		res.Batches++
	}
	if finish != nil {
		if err := s.sendNow(ctx, http.MethodPost, "/api/ingest/runs/"+header.RunID+"/finish", finish); err != nil {
			return res, err
		}
		res.Finished = true
	}
	return res, os.Remove(path)
}

// sendNow sends one request with a few quick retries for transient errors.
func (s *Streamer) sendNow(ctx context.Context, method, path string, body any) error {
	backoff := 200 * time.Millisecond
	var err error
	for attempt := 0; attempt < 4; attempt++ {
		if err = s.send(method, path, body); err == nil {
			return nil
		}
		var perm permanentError
		if errors.As(err, &perm) {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(backoff):
		}
		backoff *= 2
	}
	return err
}

// PendingSpills lists spill files in dir that are ready to upload: ones
// with a finish line (their run has ended), or not written to for minAge
// (a run that crashed). A spill file another engine is still writing is
// left alone.
func PendingSpills(dir string, minAge time.Duration, now time.Time) ([]string, error) {
	matches, err := filepath.Glob(filepath.Join(dir, "paychaos-spill-*.ndjson"))
	if err != nil {
		return nil, err
	}
	var out []string
	for _, m := range matches {
		st, err := os.Stat(m)
		if err != nil || !st.Mode().IsRegular() {
			continue
		}
		if now.Sub(st.ModTime()) >= minAge || hasFinish(m) {
			out = append(out, m)
		}
	}
	return out, nil
}

// hasFinish reports whether the file's last line is a finish line.
func hasFinish(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return false
	}
	// The finish line holds the run's findings and can be large; read the
	// tail generously.
	const tail = 4 << 20
	off := max(st.Size()-tail, 0)
	if _, err := f.Seek(off, io.SeekStart); err != nil {
		return false
	}
	b, err := io.ReadAll(f)
	if err != nil {
		return false
	}
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	last := lines[len(lines)-1]
	return strings.HasPrefix(last, `{"kind":"finish"`)
}
