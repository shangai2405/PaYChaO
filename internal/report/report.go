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
	"github.com/shangai2405/paychaos/internal/money"
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
	// MoneyAtRisk totals the findings' amounts per currency.
	MoneyAtRisk []MoneyTotal `json:"money_at_risk"`
}

// MoneyTotal is the money at risk in one currency.
type MoneyTotal struct {
	Currency    string `json:"currency"`
	AmountMinor int64  `json:"amount_minor"`
	Findings    int    `json:"findings"`
}

// String renders the total, e.g. "1,250.00 USD".
func (t MoneyTotal) String() string {
	return money.Format(money.Amount{Minor: t.AmountMinor, Currency: t.Currency})
}

// AtRisk totals findings' amounts per currency, largest first.
func AtRisk(fs []audit.Finding) []MoneyTotal {
	by := map[string]*MoneyTotal{}
	for _, f := range fs {
		if f.Currency == "" {
			continue
		}
		t := by[f.Currency]
		if t == nil {
			t = &MoneyTotal{Currency: f.Currency}
			by[f.Currency] = t
		}
		t.AmountMinor += f.AmountMinor
		t.Findings++
	}
	out := make([]MoneyTotal, 0, len(by))
	for _, t := range by {
		out = append(out, *t)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].AmountMinor != out[j].AmountMinor {
			return out[i].AmountMinor > out[j].AmountMinor
		}
		return out[i].Currency < out[j].Currency
	})
	return out
}

// MoneyText renders totals as "1,250.00 USD + 500 JPY", or "" when none.
func MoneyText(ts []MoneyTotal) string {
	parts := make([]string, len(ts))
	for i, t := range ts {
		parts[i] = t.String()
	}
	return strings.Join(parts, " + ")
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
	r.MoneyAtRisk = AtRisk(r.Findings)
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
	fmt.Fprintf(w, "Findings: %d high, %d medium, %d low\n", counts[audit.High], counts[audit.Medium], counts[audit.Low])
	if m := MoneyText(r.MoneyAtRisk); m != "" {
		fmt.Fprintf(w, "Money at risk: %s\n", m)
	}
	fmt.Fprintln(w)
	for _, f := range r.Findings {
		risk := ""
		if f.Currency != "" {
			risk = " (" + money.Format(f.Amount()) + " at risk)"
		}
		fmt.Fprintf(w, "[%s] %s%s\n    %s\n", f.Severity, f.Code, risk, f.Message)
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
