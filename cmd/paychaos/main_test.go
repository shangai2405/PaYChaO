package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/shangai2405/paychaos/internal/audit"
	"github.com/shangai2405/paychaos/internal/chaos"
	"github.com/shangai2405/paychaos/internal/report"
)

func writeScenario(t *testing.T, dir string) string {
	t.Helper()
	cfg := chaos.Config{Seed: 3, Rules: []chaos.Rule{{Name: "drop-create", Match: chaos.Match{Method: "POST", PathPrefix: "/v2/checkout/orders"},
		Fault: chaos.FaultDropAfterCommit, Probability: 1, MaxHits: 1}}}
	b, _ := json.Marshal(cfg)
	p := filepath.Join(dir, "scenario.json")
	if err := os.WriteFile(p, b, 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

// startRun runs the proxy in the background and returns its address and a
// function that stops it and returns the exit code and stdout.
func startRun(t *testing.T, args ...string) (string, func() (int, string)) {
	t.Helper()
	addrc := make(chan string, 1)
	onListening = func(p, _ string) { addrc <- p }
	t.Cleanup(func() { onListening = nil })
	ctx, cancel := context.WithCancel(context.Background())
	var out, errOut bytes.Buffer
	codec := make(chan int, 1)
	go func() { codec <- cli(ctx, append([]string{"-listen", "127.0.0.1:0"}, args...), &out, &errOut) }()
	select {
	case a := <-addrc:
		return a, func() (int, string) {
			cancel()
			code := <-codec
			return code, out.String()
		}
	case code := <-codec:
		cancel()
		t.Fatalf("exited early with %d: %s", code, errOut.String())
	case <-time.After(5 * time.Second):
		cancel()
		t.Fatal("proxy did not start")
	}
	return "", nil
}

func createOrder(t *testing.T, addr string) error {
	body := `{"intent":"CAPTURE","purchase_units":[{"amount":{"currency_code":"USD","value":"5.00"}}],"payment_source":{"paypal":{}}}`
	req, _ := http.NewRequest(http.MethodPost, "http://"+addr+"/v2/checkout/orders", strings.NewReader(body))
	req.Header.Set("Authorization", "Bearer tok")
	req.Header.Set("Content-Type", "application/json")
	c := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{DisableKeepAlives: true}}
	resp, err := c.Do(req)
	if err != nil {
		return err
	}
	io.Copy(io.Discard, resp.Body)
	return resp.Body.Close()
}

// A naive retry through the real CLI exits 2 and writes every report format.
func TestRunExitsTwoOnHighAndWritesReports(t *testing.T) {
	dir := t.TempDir()
	rep, junit, md := filepath.Join(dir, "r.json"), filepath.Join(dir, "r.xml"), filepath.Join(dir, "r.md")
	addr, stop := startRun(t, "-upstream", "mock", "-config", writeScenario(t, dir), "-report", rep, "-junit", junit, "-markdown", md)
	if err := createOrder(t, addr); err == nil {
		t.Fatal("first create should lose its response")
	}
	if err := createOrder(t, addr); err != nil {
		t.Fatal(err)
	}
	code, out := stop()
	if code != 2 {
		t.Fatalf("exit %d, want 2\n%s", code, out)
	}
	if !strings.Contains(out, audit.CodeUnsafeRetry) || !strings.Contains(out, "Faults injected: drop_after_commit=1") {
		t.Fatalf("summary missing content:\n%s", out)
	}
	r, err := report.Load(rep)
	if err != nil || len(r.Requests) != 2 || !r.HasHigh() {
		t.Fatalf("report %+v %v", r, err)
	}
	for _, p := range []string{junit, md} {
		if b, err := os.ReadFile(p); err != nil || !bytes.Contains(b, []byte(audit.CodeUnsafeRetry)) {
			t.Fatalf("%s: %v %s", p, err, b)
		}
	}
}

func TestFailOnHighCanBeDisabled(t *testing.T) {
	dir := t.TempDir()
	addr, stop := startRun(t, "-upstream", "mock", "-config", writeScenario(t, dir), "-report", filepath.Join(dir, "r.json"), "-fail-on-high=false")
	_ = createOrder(t, addr)
	_ = createOrder(t, addr)
	if code, _ := stop(); code != 0 {
		t.Fatalf("exit %d, want 0", code)
	}
}

func TestRefusesLiveUpstream(t *testing.T) {
	var out, errOut bytes.Buffer
	for _, up := range []string{"https://api-m.paypal.com", "http://127.0.0.1:9"} {
		if code := cli(context.Background(), []string{"-listen", "127.0.0.1:0", "-upstream", up}, &out, &errOut); code != 1 {
			t.Fatalf("%s: exit %d, want 1", up, code)
		}
	}
	if !strings.Contains(errOut.String(), "refusing to start") {
		t.Fatalf("stderr: %s", errOut.String())
	}
}

// An explicitly allowed local mock is accepted.
func TestAllowUpstreamAcceptsLocalMock(t *testing.T) {
	m := httptest.NewServer(http.NotFoundHandler())
	defer m.Close()
	host := strings.TrimPrefix(m.URL, "http://")
	_, stop := startRun(t, "-upstream", m.URL, "-allow-upstream", host, "-report", filepath.Join(t.TempDir(), "r.json"))
	if code, _ := stop(); code != 0 {
		t.Fatalf("exit %d", code)
	}
}

// Streaming: the run, its batches and the finish message reach the API.
func TestReportToStreamsRun(t *testing.T) {
	var mu sync.Mutex
	var paths []string
	var finish map[string]any
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		paths = append(paths, r.Method+" "+r.URL.Path)
		if r.Header.Get("Authorization") != "Bearer pct_x" {
			w.WriteHeader(401)
			return
		}
		if strings.HasSuffix(r.URL.Path, "/finish") {
			_ = json.NewDecoder(r.Body).Decode(&finish)
		}
	}))
	defer api.Close()
	dir := t.TempDir()
	addr, stop := startRun(t, "-upstream", "mock", "-config", writeScenario(t, dir), "-report", filepath.Join(dir, "r.json"),
		"-report-to", api.URL, "-token", "pct_x", "-fail-on-high=false")
	_ = createOrder(t, addr)
	_ = createOrder(t, addr)
	code, out := stop()
	if code != 0 || !strings.Contains(out, "Streamed run") {
		t.Fatalf("exit %d\n%s", code, out)
	}
	mu.Lock()
	defer mu.Unlock()
	joined := strings.Join(paths, "\n")
	for _, want := range []string{"PUT /api/ingest/runs/", "/batches", "/finish"} {
		if !strings.Contains(joined, want) {
			t.Fatalf("missing %q in\n%s", want, joined)
		}
	}
	if finish == nil || finish["request_count"].(float64) != 2 {
		t.Fatalf("finish %+v", finish)
	}
}

func TestReportToNeedsToken(t *testing.T) {
	t.Setenv("PAYCHAOS_TOKEN", "")
	var out, errOut bytes.Buffer
	if code := cli(context.Background(), []string{"-upstream", "mock", "-report-to", "http://127.0.0.1:1"}, &out, &errOut); code != 1 {
		t.Fatalf("exit %d", code)
	}
}

func TestScenarioValidateAndVersion(t *testing.T) {
	var out, errOut bytes.Buffer
	if cli(context.Background(), []string{"scenario"}, &out, &errOut) != 0 {
		t.Fatal("scenario failed")
	}
	dir := t.TempDir()
	good := filepath.Join(dir, "good.json")
	_ = os.WriteFile(good, out.Bytes(), 0o644)
	bad := filepath.Join(dir, "bad.json")
	_ = os.WriteFile(bad, []byte(`{"rules":[{"name":"x","fault":"explode","probability":1}]}`), 0o644)

	out.Reset()
	if code := cli(context.Background(), []string{"validate", good}, &out, &errOut); code != 0 {
		t.Fatalf("default scenario invalid: %s", errOut.String())
	}
	if code := cli(context.Background(), []string{"validate", good, bad}, &out, &errOut); code != 1 || !strings.Contains(errOut.String(), "token_expired_401") {
		t.Fatalf("bad scenario: exit %d, %s", code, errOut.String())
	}
	if code := cli(context.Background(), []string{"validate"}, &out, &errOut); code != 1 {
		t.Fatal("validate without files should fail")
	}
	out.Reset()
	if cli(context.Background(), []string{"version"}, &out, &errOut) != 0 || !strings.HasPrefix(out.String(), "paychaos ") {
		t.Fatal("version")
	}
}

func TestCompareExitCodes(t *testing.T) {
	dir := t.TempDir()
	base := report.Report{Seed: 1, Findings: []audit.Finding{}}
	cur := report.Report{Seed: 1, Findings: []audit.Finding{{Code: audit.CodeMissingRequestID, Severity: audit.Medium, Path: "/v2/checkout/orders"}}}
	bp, cp := filepath.Join(dir, "b.json"), filepath.Join(dir, "c.json")
	_ = base.WriteJSON(bp)
	_ = cur.WriteJSON(cp)
	var out, errOut bytes.Buffer
	if code := cli(context.Background(), []string{"compare", bp, cp}, &out, &errOut); code != 0 {
		t.Fatalf("medium regression with -fail-on high: exit %d", code)
	}
	if code := cli(context.Background(), []string{"compare", "-fail-on", "medium", bp, cp}, &out, &errOut); code != 2 {
		t.Fatalf("exit %d, want 2", code)
	}
	out.Reset()
	if code := cli(context.Background(), []string{"compare", "-json", "-fail-on", "low", cp, bp}, &out, &errOut); code != 0 || !json.Valid(out.Bytes()) {
		t.Fatalf("improvement: exit %d %s", code, out.String())
	}
	for _, args := range [][]string{{"compare", bp}, {"compare", "-fail-on", "bad", bp, cp}, {"compare", bp, filepath.Join(dir, "missing.json")}} {
		if code := cli(context.Background(), args, &out, &errOut); code != 1 {
			t.Fatalf("%v: exit %d", args, code)
		}
	}
}

func TestMockSubcommand(t *testing.T) {
	addrc := make(chan string, 1)
	onListening = func(p, _ string) { addrc <- p }
	defer func() { onListening = nil }()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan int, 1)
	var errOut bytes.Buffer
	go func() { done <- cli(ctx, []string{"mock", "-listen", "127.0.0.1:0"}, io.Discard, &errOut) }()
	addr := <-addrc
	resp, err := http.Get("http://" + addr + "/__mock/stats")
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("%v %v", resp, err)
	}
	resp.Body.Close()
	cancel()
	if code := <-done; code != 0 {
		t.Fatalf("exit %d", code)
	}
}

// Two runs with the same seed print byte-identical summaries.
func TestTextReportIsDeterministic(t *testing.T) {
	r := report.Report{Seed: 9, FaultsApplied: map[chaos.Fault]int{"rate_limit_429": 2, "drop_after_commit": 1, "latency": 4, "error_500": 3}}
	var first bytes.Buffer
	r.WriteText(&first)
	for i := 0; i < 50; i++ {
		var again bytes.Buffer
		r.WriteText(&again)
		if again.String() != first.String() {
			t.Fatal("text report changed between runs")
		}
	}
	if !strings.Contains(first.String(), "drop_after_commit=1 error_500=3 latency=4 rate_limit_429=2") {
		t.Fatalf("faults not sorted: %s", first.String())
	}
}
