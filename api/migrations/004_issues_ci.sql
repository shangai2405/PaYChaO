-- Issues: one row per distinct problem in a project (finding code plus the
-- operation or path it happened on), tracked across runs as new, open,
-- fixed or regressed. Findings stay per run and point at their issue.

CREATE TABLE issues (
  id              bigserial PRIMARY KEY,
  project_id      uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key             text NOT NULL,
  code            text NOT NULL,
  severity        text NOT NULL CHECK (severity IN ('HIGH', 'MEDIUM', 'LOW')),
  operation       text NOT NULL DEFAULT '',
  path            text NOT NULL DEFAULT '',
  message         text NOT NULL DEFAULT '',
  status          text NOT NULL CHECK (status IN ('new', 'open', 'fixed', 'regressed')),
  times_seen      integer NOT NULL DEFAULT 1,
  first_seen_run  uuid REFERENCES runs(id) ON DELETE SET NULL,
  first_seen_at   timestamptz NOT NULL,
  last_seen_run   uuid REFERENCES runs(id) ON DELETE SET NULL,
  last_seen_at    timestamptz NOT NULL,
  fixed_run       uuid REFERENCES runs(id) ON DELETE SET NULL,
  fixed_at        timestamptz,
  regressed_at    timestamptz,
  amount_minor    bigint CHECK (amount_minor >= 0),
  currency        text CHECK (currency ~ '^[A-Z]{3}$'),
  ignored_at      timestamptz,
  ignored_reason  text NOT NULL DEFAULT '' CHECK (length(ignored_reason) <= 500),
  UNIQUE (project_id, key)
);
CREATE INDEX issues_project_status ON issues (project_id, status);

ALTER TABLE findings
  ADD COLUMN issue_key text NOT NULL DEFAULT '',
  ADD COLUMN issue_id bigint REFERENCES issues(id) ON DELETE SET NULL;

-- Where a run came from, so pull-request runs can be compared with the
-- latest run of their base branch. Filled in by `paychaos ci`.
ALTER TABLE runs
  ADD COLUMN ci_provider text NOT NULL DEFAULT '',
  ADD COLUMN repo text NOT NULL DEFAULT '',
  ADD COLUMN branch text NOT NULL DEFAULT '',
  ADD COLUMN commit_sha text NOT NULL DEFAULT '',
  ADD COLUMN pr_number integer,
  ADD COLUMN base_branch text NOT NULL DEFAULT '',
  ADD COLUMN ci_url text NOT NULL DEFAULT '',
  ADD COLUMN scenario_name text NOT NULL DEFAULT '',
  ADD COLUMN scenario_version integer,
  -- Set once this run's findings have updated issue statuses, so a resent
  -- finish (it is idempotent) does not count a sighting twice.
  ADD COLUMN issues_applied boolean NOT NULL DEFAULT false;

CREATE INDEX runs_project_branch ON runs (project_id, branch, started_at DESC)
  WHERE status = 'finished' AND pr_number IS NULL;

-- The branch whose runs move issue status (learned from CI, editable).
ALTER TABLE projects ADD COLUMN default_branch text NOT NULL DEFAULT ''
  CHECK (length(default_branch) <= 200);

-- Scenarios get a version that increases on every save, recorded on the
-- runs that use them.
ALTER TABLE scenarios ADD COLUMN version integer NOT NULL DEFAULT 1;
