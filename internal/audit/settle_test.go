package audit

import (
	"fmt"
	"testing"
	"time"

	"github.com/shangai2405/paychaos/internal/chaos"
)

// Idle operations are judged with the same rules as at the end of the run,
// then released, so findings are identical with and without settling.
func TestSettleKeepsFindingsAndReleasesMemory(t *testing.T) {
	run := func(settle time.Duration) (*Auditor, []Finding) {
		a, now := newClocked(0)
		a.WithSettleAfter(settle)
		// A lost response the client never retried: decided at report time.
		lost := a.Begin("POST", "/v2/checkout/orders", "k-lost", "fp-lost")
		a.Complete(lost, "r", chaos.FaultDropAfterCommit, 201, true, "ORDER-LOST")
		// A 422 already-captured never followed by a GET.
		dup := a.Begin("POST", "/v2/checkout/orders/O1/capture", "", "fp-cap")
		a.CompleteWith(dup, Outcome{Fault: chaos.FaultNone, UpstreamStatus: 422, Issue: "ORDER_ALREADY_CAPTURED"})
		*now = now.Add(2 * time.Minute)
		// Plenty of later, healthy traffic triggers sweeps.
		for i := 0; i < 3*settleEvery; i++ {
			s := a.Begin("POST", "/v2/checkout/orders", fmt.Sprintf("k%d", i), fmt.Sprintf("fp%d", i))
			a.Complete(s, "", chaos.FaultNone, 201, true, fmt.Sprintf("O%d", i))
			*now = now.Add(time.Second)
		}
		return a, a.Findings()
	}

	keep, kf := run(0)
	settled, sf := run(time.Minute)

	if !has(sf, CodeUnreconciled) || !has(sf, CodeAlreadyCaptured) {
		t.Fatalf("settled run lost end-of-run findings: %+v", sf)
	}
	if len(kf) != len(sf) {
		t.Fatalf("findings differ: %d without settling, %d with", len(kf), len(sf))
	}
	if keep.Held() != 2+3*settleEvery {
		t.Fatalf("without settling every record is held, got %d", keep.Held())
	}
	if settled.Held() >= keep.Held()/2 {
		t.Fatalf("settling released too little: %d held", settled.Held())
	}
	n, faults := settled.Settled()
	if n+settled.Held() != 2+3*settleEvery {
		t.Fatalf("settled %d + held %d != total", n, settled.Held())
	}
	if faults[chaos.FaultDropAfterCommit] != 1 {
		t.Fatalf("settled faults not counted: %v", faults)
	}
	if len(settled.Records()) != settled.Held() {
		t.Fatal("Records() should list exactly the held records")
	}
}

// An operation with an attempt still in flight is never settled, however old.
func TestSettleWaitsForPendingAttempts(t *testing.T) {
	a, now := newClocked(0)
	a.WithSettleAfter(time.Minute)
	first := a.Begin("POST", "/v2/payments/captures/C1/refund", "", "fp-refund")
	a.Complete(first, "r", chaos.FaultDropAfterCommit, 201, true, "REFUND-1")
	pending := a.Begin("POST", "/v2/payments/captures/C1/refund", "", "fp-refund")
	*now = now.Add(time.Hour)
	for i := 0; i < settleEvery; i++ {
		a.Complete(a.Begin("POST", "/v2/checkout/orders", "", fmt.Sprintf("x%d", i)), "", chaos.FaultNone, 201, true, "")
	}
	// The retry finally completes and commits: still recognised as a duplicate.
	a.Complete(pending, "", chaos.FaultNone, 201, true, "REFUND-2")
	if !has(a.Findings(), CodeUnsafeRetry) {
		t.Fatal("a pending retry's group was settled before it completed")
	}
}

// Memory stays flat over a long run of distinct operations.
func TestSettleBoundsMemoryOnLongRuns(t *testing.T) {
	a, now := newClocked(0)
	a.WithSettleAfter(10 * time.Second)
	peak := 0
	for i := 0; i < 50_000; i++ {
		s := a.Begin("POST", "/v2/checkout/orders", fmt.Sprintf("k%d", i), fmt.Sprintf("fp%d", i))
		a.Complete(s, "", chaos.FaultNone, 201, true, "")
		a.Observe("GET", fmt.Sprintf("/v2/checkout/orders/O%d", i))
		*now = now.Add(100 * time.Millisecond)
		if h := a.Held(); h > peak {
			peak = h
		}
	}
	// 10s idle window at 10 requests/s plus one sweep interval of slack.
	if peak > 100+2*settleEvery {
		t.Fatalf("held up to %d records; expected a bounded working set", peak)
	}
	if len(a.keyFP) > 100+2*settleEvery || len(a.gets) > 100+2*settleEvery {
		t.Fatalf("side tables grew: %d request ids, %d GETs", len(a.keyFP), len(a.gets))
	}
}
