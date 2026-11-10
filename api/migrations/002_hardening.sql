-- Token usage tracking, project descriptions, and an index for the
-- per-operation timeline's findings join.

-- When a token last authenticated an ingest call. Written at most once a
-- minute per token (see auth.ts) so a busy engine doesn't turn every batch
-- into an extra row update.
ALTER TABLE ingest_tokens ADD COLUMN last_used_at timestamptz;

ALTER TABLE projects ADD COLUMN description text NOT NULL DEFAULT ''
  CHECK (length(description) <= 500);

-- /api/runs/:id/operations joins findings on (run_id, fingerprint); the old
-- (run_id, severity) index made that a per-run scan of every finding.
CREATE INDEX findings_run_fingerprint ON findings (run_id, fingerprint);

-- The project health view reads the latest finished runs of a project.
CREATE INDEX runs_project_finished ON runs (project_id, started_at DESC) WHERE status = 'finished';
