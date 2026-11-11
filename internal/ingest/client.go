package ingest

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Scenario is a scenario saved in the dashboard, as served to the engine.
type Scenario struct {
	Name    string          `json:"name"`
	Version int             `json:"version"`
	Config  json.RawMessage `json:"config"`
}

// MoneyTotal is money at risk in one currency.
type MoneyTotal struct {
	Currency    string `json:"currency"`
	AmountMinor int64  `json:"amount_minor"`
	Findings    int    `json:"findings"`
}

// VerdictItem is one problem in a verdict.
type VerdictItem struct {
	Key         string       `json:"key"`
	Code        string       `json:"code"`
	Severity    string       `json:"severity"`
	Operation   string       `json:"operation"`
	Path        string       `json:"path"`
	Count       int          `json:"count"`
	MoneyAtRisk []MoneyTotal `json:"money_at_risk"`
}

// Verdict compares a finished run with its baseline (see the API's
// /api/ingest/runs/:id/verdict).
type Verdict struct {
	Baseline *struct {
		ID     string `json:"id"`
		Branch string `json:"branch"`
	} `json:"baseline"`
	BaseBranch     string        `json:"base_branch"`
	New            []VerdictItem `json:"new"`
	Fixed          []VerdictItem `json:"fixed"`
	Unchanged      []VerdictItem `json:"unchanged"`
	NotRetested    []VerdictItem `json:"not_retested"`
	WorstNew       string        `json:"worst_new"`
	MoneyAtRisk    []MoneyTotal  `json:"money_at_risk"`
	NewMoneyAtRisk []MoneyTotal  `json:"new_money_at_risk"`
	Markdown       string        `json:"markdown"`
}

func getJSON(ctx context.Context, baseURL, token, path string, out any) error {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimSuffix(baseURL, "/")+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if resp.StatusCode != http.StatusOK {
		var e struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(body, &e)
		if e.Error == "" {
			e.Error = strings.TrimSpace(string(body))
		}
		return fmt.Errorf("GET %s: %d %s", path, resp.StatusCode, e.Error)
	}
	return json.Unmarshal(body, out)
}

// FetchScenario loads a scenario saved in the token's project by name.
func FetchScenario(ctx context.Context, baseURL, token, name string) (Scenario, error) {
	var s Scenario
	err := getJSON(ctx, baseURL, token, "/api/ingest/scenarios/"+url.PathEscape(name), &s)
	return s, err
}

// FetchVerdict loads the verdict for a finished run.
func FetchVerdict(ctx context.Context, baseURL, token, runID string) (Verdict, error) {
	var v Verdict
	err := getJSON(ctx, baseURL, token, "/api/ingest/runs/"+url.PathEscape(runID)+"/verdict", &v)
	return v, err
}
