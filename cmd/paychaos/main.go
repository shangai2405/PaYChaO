// Command paychaos is a chaos-testing proxy for PayPal REST API integrations
// (sandbox only).
//
//	paychaos [flags]          run the fault-injecting proxy (and optional webhook relay)
//	paychaos mock [-listen]   run the bundled PayPal-shaped mock API
//	paychaos scenario         print the default scenario as JSON
//	paychaos validate FILE... check scenario files without running anything
//	paychaos compare BASE CUR compare two JSON reports; exit 2 on new findings
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/shangai2405/paychaos/internal/audit"
	"github.com/shangai2405/paychaos/internal/chaos"
	"github.com/shangai2405/paychaos/internal/ingest"
	"github.com/shangai2405/paychaos/internal/mock"
	"github.com/shangai2405/paychaos/internal/proxy"
	"github.com/shangai2405/paychaos/internal/report"
	"github.com/shangai2405/paychaos/internal/webhook"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = "dev"

// onListening is called once the servers are bound; tests use it to learn
// the ports when listening on :0.
var onListening func(proxyAddr, webhookAddr string)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	os.Exit(cli(ctx, os.Args[1:], os.Stdout, os.Stderr))
}

// cli dispatches subcommands and returns the process exit code.
func cli(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	if len(args) > 0 {
		switch args[0] {
		case "mock":
			return runMock(ctx, args[1:], stderr)
		case "scenario":
			b, _ := json.MarshalIndent(chaos.DefaultConfig(), "", "  ")
			fmt.Fprintln(stdout, string(b))
			return 0
		case "validate":
			return runValidate(args[1:], stdout, stderr)
		case "compare":
			return runCompare(args[1:], stdout, stderr)
		case "version":
			fmt.Fprintln(stdout, "paychaos", version)
			return 0
		}
	}
	return run(ctx, args, stdout, stderr)
}

type listFlag []string

func (l *listFlag) String() string     { return strings.Join(*l, ",") }
func (l *listFlag) Set(v string) error { *l = append(*l, v); return nil }

func run(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("paychaos", flag.ContinueOnError)
	fs.SetOutput(stderr)
	listen := fs.String("listen", "127.0.0.1:8080", "address the API proxy listens on")
	upstream := fs.String("upstream", "https://api-m.sandbox.paypal.com", `upstream API base URL (a PayPal sandbox host), or "mock" for the built-in mock`)
	var allow listFlag
	fs.Var(&allow, "allow-upstream", "extra upstream host[:port] to accept, e.g. a mock started with `paychaos mock` (repeatable)")
	cfgPath := fs.String("config", "", "scenario JSON file (default: built-in scenario; see `paychaos scenario`)")
	seed := fs.Int64("seed", -1, "override the scenario seed (-1 keeps the file's seed)")
	whListen := fs.String("webhook-listen", "", "address for the webhook relay, e.g. 127.0.0.1:8081 (disabled if empty)")
	whTarget := fs.String("webhook-target", "", "your app's webhook endpoint the relay delivers to")
	reportPath := fs.String("report", "paychaos-report.json", "where to write the JSON report on exit")
	junitPath := fs.String("junit", "", "also write findings as JUnit XML to this file, for CI test reporters")
	mdPath := fs.String("markdown", "", "also write a Markdown summary to this file (\"-\" for stdout), e.g. $GITHUB_STEP_SUMMARY")
	duration := fs.Duration("duration", 0, "stop automatically after this long (0 = until Ctrl-C)")
	failOnHigh := fs.Bool("fail-on-high", true, "exit with status 2 if any HIGH finding was detected (for CI)")
	reportTo := fs.String("report-to", "", "paychaos API base URL to stream this run to, e.g. http://127.0.0.1:3000")
	token := fs.String("token", "", "project ingest token for -report-to (default $PAYCHAOS_TOKEN)")
	runName := fs.String("run-name", "", "label for this run in the dashboard")
	mockDelay := fs.Duration("mock-exec-delay", 0, "with -upstream mock: how long each POST executes (same-id retries meanwhile collide)")
	mockErrEvery := fs.Int("mock-server-error-every", 0, "with -upstream mock: every Nth POST returns 500 after creating the resource")
	mockTTL := fs.Duration("mock-request-id-ttl", 0, "with -upstream mock: forget PayPal-Request-Id values after this long, to test late retries")
	settleAfter := fs.Duration("settle-after", 30*time.Minute, "judge and release operations idle this long, to bound memory on long runs (0 = keep every request until exit)")
	if err := fs.Parse(args); err != nil {
		return 1
	}

	log := slog.New(slog.NewTextHandler(stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))

	cfg := chaos.DefaultConfig()
	if *cfgPath != "" {
		var err error
		if cfg, err = chaos.LoadConfig(*cfgPath); err != nil {
			log.Error("invalid scenario", "err", err)
			return 1
		}
	}
	if *seed >= 0 {
		cfg.Seed = uint64(*seed)
	}

	var streamer *ingest.Streamer
	if *reportTo != "" {
		tok := *token
		if tok == "" {
			tok = os.Getenv("PAYCHAOS_TOKEN")
		}
		var err error
		if streamer, err = ingest.New(ingest.Options{BaseURL: *reportTo, Token: tok, Logger: log}); err != nil {
			log.Error("-report-to needs -token or $PAYCHAOS_TOKEN", "err", err)
			return 1
		}
	}

	engine := chaos.NewEngine(cfg)
	auditor := audit.New(cfg.MutatingPaths, time.Duration(cfg.MinBackoffMS)*time.Millisecond).
		WithRequestIDPaths(cfg.RequestIDPaths).
		WithOperationID(cfg.OperationID).
		WithSettleAfter(*settleAfter)
	if streamer != nil {
		auditor.WithHooks(streamer.Hooks())
	}

	var up *url.URL
	upstreamLabel := *upstream
	if *upstream == "mock" {
		m := httptest.NewServer(mock.NewWithOptions(mock.Options{ExecDelay: *mockDelay, ServerErrorEvery: *mockErrEvery, RequestIDTTL: *mockTTL}))
		defer m.Close()
		up, _ = url.Parse(m.URL)
		allow = append(allow, up.Host)
		log.Info("using built-in mock upstream", "url", m.URL)
	} else {
		var err error
		if up, err = url.Parse(*upstream); err != nil || up.Scheme == "" || up.Host == "" {
			log.Error("invalid -upstream", "value", *upstream)
			return 1
		}
	}

	px, err := proxy.New(proxy.Options{Upstream: up, Engine: engine, Auditor: auditor, Logger: log, AllowedHosts: allow})
	if err != nil {
		log.Error("refusing to start", "err", err)
		return 1
	}

	var relay *webhook.Relay
	mux := http.NewServeMux()
	mux.HandleFunc("GET /__paychaos/report", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(report.Build(cfg.Seed, auditor, relay))
	})
	mux.Handle("/", px)

	type server struct {
		srv *http.Server
		ln  net.Listener
	}
	pln, err := net.Listen("tcp", *listen)
	if err != nil {
		log.Error("listen", "err", err)
		return 1
	}
	servers := []server{{&http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}, pln}}
	whAddr := ""
	if *whListen != "" {
		if *whTarget == "" {
			_ = pln.Close()
			log.Error("-webhook-listen needs -webhook-target")
			return 1
		}
		wln, err := net.Listen("tcp", *whListen)
		if err != nil {
			_ = pln.Close()
			log.Error("listen", "err", err)
			return 1
		}
		whAddr = wln.Addr().String()
		relay = webhook.New(*whTarget, cfg.Webhooks, chaos.NewStream(cfg.Seed, chaos.StreamWebhooks), log)
		if streamer != nil {
			relay.OnDelivery(streamer.OnDelivery)
		}
		servers = append(servers, server{&http.Server{Handler: relay, ReadHeaderTimeout: 10 * time.Second}, wln})
	}

	if streamer != nil {
		scen, _ := json.Marshal(cfg)
		streamer.Start(ingest.RunMeta{Name: *runName, Seed: cfg.Seed, Upstream: upstreamLabel, Scenario: scen,
			StartedAt: time.Now().UTC(), Version: version})
		log.Info("streaming run to API", "url", *reportTo, "run_id", streamer.RunID())
	}

	errc := make(chan error, len(servers))
	for _, s := range servers {
		go func(s server) {
			if err := s.srv.Serve(s.ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
				errc <- err
			}
		}(s)
	}
	log.Info("paychaos running", "proxy", pln.Addr().String(), "upstream", up.String(), "seed", cfg.Seed, "webhook_relay", whAddr)
	if onListening != nil {
		onListening(pln.Addr().String(), whAddr)
	}

	if *duration > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, *duration)
		defer cancel()
	}
	select {
	case <-ctx.Done():
	case err := <-errc:
		log.Error("server failed", "err", err)
		return 1
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for _, s := range servers {
		_ = s.srv.Shutdown(shutdownCtx)
	}
	if relay != nil {
		relay.Close()
	}

	rep := report.Build(cfg.Seed, auditor, relay)
	if streamer != nil {
		faults := map[string]int{}
		for f, n := range rep.FaultsApplied {
			faults[string(f)] = n
		}
		closeCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		st, err := streamer.Close(closeCtx, ingest.Finish{FinishedAt: time.Now().UTC(), Findings: rep.Findings,
			FaultsApplied: faults, Webhooks: rep.Webhooks, WebhookNotes: rep.WebhookNotes, RequestCount: rep.RequestCount})
		cancel()
		if err != nil {
			log.Warn("could not finish streaming the run", "err", err)
		}
		if st.Spilled > 0 {
			log.Warn("some events could not be sent", "spilled", st.Spilled, "file", streamer.SpillPath())
		}
		fmt.Fprintf(stdout, "Streamed run %s: %d events in %d batches\n", streamer.RunID(), st.Sent, st.Batches)
	}
	rep.WriteText(stdout)
	if err := rep.WriteJSON(*reportPath); err != nil {
		log.Error("writing report", "err", err)
	} else {
		fmt.Fprintf(stdout, "\nFull report: %s\n", *reportPath)
	}
	if *junitPath != "" {
		if err := rep.WriteJUnit(*junitPath); err != nil {
			log.Error("writing JUnit report", "err", err)
		}
	}
	if *mdPath != "" {
		if err := writeMarkdown(rep, *mdPath, stdout); err != nil {
			log.Error("writing Markdown report", "err", err)
		}
	}
	if *failOnHigh && rep.HasHigh() {
		return 2
	}
	return 0
}

func runMock(ctx context.Context, args []string, stderr io.Writer) int {
	fs := flag.NewFlagSet("mock", flag.ContinueOnError)
	fs.SetOutput(stderr)
	listen := fs.String("listen", "127.0.0.1:12111", "address for the mock API")
	delay := fs.Duration("exec-delay", 0, "how long each POST executes (same-id retries meanwhile collide)")
	errEvery := fs.Int("server-error-every", 0, "every Nth POST returns 500 after creating the resource (0 = never)")
	ttl := fs.Duration("request-id-ttl", 0, "forget PayPal-Request-Id values after this long (0 = never)")
	strict := fs.Bool("strict-tokens", false, "reject bearer tokens the mock did not issue")
	if err := fs.Parse(args); err != nil {
		return 1
	}
	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	fmt.Fprintf(stderr, "mock PayPal-shaped API on http://%s (stats at /__mock/stats)\n", ln.Addr())
	srv := &http.Server{Handler: mock.NewWithOptions(mock.Options{ExecDelay: *delay, ServerErrorEvery: *errEvery,
		RequestIDTTL: *ttl, StrictTokens: *strict}), ReadHeaderTimeout: 10 * time.Second}
	if onListening != nil {
		onListening(ln.Addr().String(), "")
	}
	go func() {
		<-ctx.Done()
		_ = srv.Close()
	}()
	if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		fmt.Fprintln(stderr, err)
		return 1
	}
	return 0
}

// writeMarkdown appends to path rather than truncating it, because
// $GITHUB_STEP_SUMMARY is shared by every step of a job.
func writeMarkdown(rep report.Report, path string, stdout io.Writer) error {
	if path == "-" {
		rep.WriteMarkdown(stdout)
		return nil
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	rep.WriteMarkdown(f)
	return f.Close()
}

func runValidate(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprintln(stderr, "usage: paychaos validate SCENARIO.json...")
		return 1
	}
	bad := 0
	for _, path := range args {
		cfg, err := chaos.LoadConfig(path)
		if err != nil {
			fmt.Fprintf(stderr, "FAIL %s: %v\n", path, err)
			bad++
			continue
		}
		fmt.Fprintf(stdout, "ok   %s (seed %d, %d rules)\n", path, cfg.Seed, len(cfg.Rules))
	}
	if bad > 0 {
		fmt.Fprintf(stderr, "\nknown faults: %v\n", chaos.KnownFaults())
		return 1
	}
	return 0
}

func runCompare(args []string, stdout, stderr io.Writer) int {
	fs := flag.NewFlagSet("compare", flag.ContinueOnError)
	fs.SetOutput(stderr)
	failOn := fs.String("fail-on", "high", "exit 2 when a new finding is at least this severe: high, medium or low")
	asJSON := fs.Bool("json", false, "print the comparison as JSON")
	if err := fs.Parse(args); err != nil {
		return 1
	}
	if fs.NArg() != 2 {
		fmt.Fprintln(stderr, "usage: paychaos compare [-fail-on high|medium|low] [-json] BASELINE.json CURRENT.json")
		return 1
	}
	min := audit.Severity(strings.ToUpper(*failOn))
	if min != audit.High && min != audit.Medium && min != audit.Low {
		fmt.Fprintf(stderr, "-fail-on must be high, medium or low, not %q\n", *failOn)
		return 1
	}
	base, err := report.Load(fs.Arg(0))
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	cur, err := report.Load(fs.Arg(1))
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	d := report.Compare(base, cur)
	if *asJSON {
		b, _ := json.MarshalIndent(d, "", "  ")
		fmt.Fprintln(stdout, string(b))
	} else {
		d.WriteText(stdout)
	}
	if d.Regressed(min) {
		return 2
	}
	return 0
}
