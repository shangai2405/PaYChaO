// Package report renders the results of a run as JSON and as a terminal summary.
package report

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/shangai2405/paychaos/internal/audit"
	"github.com/shangai2405/paychaos/internal/chaos"
	"github.com/shangai2405/paychaos/internal/webhook"
)

// Report is the full machine-readable result of a run.
type Report struct {
	GeneratedAt time.Time       `json:"generated_at"`
	Seed        uint64          `json:"seed"`
	Findings    []audit.Finding `json:"findings"`
	// RequestCount is every audited request of the run. Requests holds the
	// records still in memory at the end; with -settle-after, operations
	// that went idle earlier were judged and released, and SettledRequests
	// counts them (their findings are in Findings).
	RequestCount    int                    `json:"request_count"`
	SettledRequests int                    `json:"settled_requests,omitempty"`
	Requests        []audit.Record         `json:"requests"`
	Webhooks        []webhook.EventSummary `json:"webhooks,omitempty"`
	WebhookNotes    []string               `json:"webhook_notes,omitempty"`
	FaultsApplied   map[chaos.Fault]int    `json:"faults_applied"`
}

// Build assembles a report. relay may be nil.
func Build(seed uint64, a *audit.Auditor, relay *webhook.Relay) Report {
	r := Report{
		GeneratedAt:   time.Now().UTC(),
		Seed:          seed,
		Findings:      a.Findings(),
		Requests:      a.Records(),
		FaultsApplied: map[chaos.Fault]int{},
	}
	for _, rec := range r.Requests {
		if rec.Fault != "" && rec.Fault != chaos.FaultNone {
			r.FaultsApplied[rec.Fault]++
		}
	}
	settled, faults := a.Settled()
	for f, n := range faults {
		r.FaultsApplied[f] += n
	}
	r.SettledRequests = settled
	r.RequestCount = len(r.Requests) + settled
	if relay != nil {
		r.Webhooks = relay.Summaries()
		r.WebhookNotes = webhook.Notes(r.Webhooks)
	}
	if r.Findings == nil {
		r.Findings = []audit.Finding{}
	}
	return r
}

// sortedFaults returns the applied faults in name order, so two runs with the
// same seed print byte-identical summaries.
func (r Report) sortedFaults() []chaos.Fault {
	out := make([]chaos.Fault, 0, len(r.FaultsApplied))
	for f := range r.FaultsApplied {
		out = append(out, f)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

// HasHigh reports whether any HIGH finding exists (used for the exit code).
func (r Report) HasHigh() bool {
	for _, f := range r.Findings {
		if f.Severity == audit.High {
			return true
		}
	}
	return false
}

// WriteJSON writes the report to path.
func (r Report) WriteJSON(path string) error {
	b, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o644)
}

// WriteText prints a human summary.
func (r Report) WriteText(w io.Writer) {
	fmt.Fprintf(w, "\npaychaos report (seed %d)\n%s\n", r.Seed, strings.Repeat("=", 40))
	fmt.Fprintf(w, "Audited payment requests: %d\n", r.RequestCount)
	if len(r.FaultsApplied) > 0 {
		fmt.Fprintf(w, "Faults injected:")
		for _, f := range r.sortedFaults() {
			fmt.Fprintf(w, " %s=%d", f, r.FaultsApplied[f])
		}
		fmt.Fprintln(w)
	}
	counts := map[audit.Severity]int{}
	for _, f := range r.Findings {
		counts[f.Severity]++
	}
	fmt.Fprintf(w, "Findings: %d high, %d medium, %d low\n\n", counts[audit.High], counts[audit.Medium], counts[audit.Low])
	for _, f := range r.Findings {
		fmt.Fprintf(w, "[%s] %s\n    %s\n", f.Severity, f.Code, f.Message)
	}
	if len(r.Webhooks) > 0 {
		dups, reord := 0, 0
		for _, s := range r.Webhooks {
			if s.Deliveries > 1 {
				dups++
			}
			if s.Reordered {
				reord++
			}
		}
		fmt.Fprintf(w, "\nWebhooks: %d events, %d duplicated, %d reordered\n", len(r.Webhooks), dups, reord)
		for _, n := range r.WebhookNotes {
			fmt.Fprintf(w, "  - %s\n", n)
		}
	}
	if len(r.Findings) == 0 && len(r.WebhookNotes) == 0 {
		fmt.Fprintln(w, "No problems detected in this run. Try more traffic, another seed, or a harsher scenario.")
	}
}
