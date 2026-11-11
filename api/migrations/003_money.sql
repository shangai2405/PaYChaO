-- Money at risk: what each request moved and what each finding puts at
-- risk, in minor units of one currency (never mixed, never floating point).

ALTER TABLE requests
  ADD COLUMN amount_minor bigint CHECK (amount_minor >= 0),
  ADD COLUMN currency text CHECK (currency ~ '^[A-Z]{3}$');

ALTER TABLE findings
  ADD COLUMN amount_minor bigint CHECK (amount_minor >= 0),
  ADD COLUMN currency text CHECK (currency ~ '^[A-Z]{3}$');

-- Per-currency totals of a finished run: [{currency, amount_minor, findings}].
ALTER TABLE runs ADD COLUMN money_at_risk jsonb NOT NULL DEFAULT '[]';
