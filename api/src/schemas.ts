import { z } from 'zod';

// These mirror the Go engine's JSON (internal/audit, internal/webhook,
// internal/ingest, internal/chaos). Unknown keys are stripped, so a newer
// engine sending extra fields still ingests.

export const KNOWN_FAULTS = [
  'none',
  'latency',
  'error_500',
  'rate_limit_429',
  'drop_after_commit',
  'timeout_before_forward',
  'error_500_after_commit',
  'hold_response',
  'truncate_after_commit',
  'token_expired_401',
] as const;

export const SEVERITIES = ['HIGH', 'MEDIUM', 'LOW'] as const;

const isoDate = z.string().datetime({ offset: true });
// Go encodes the zero time.Time as 0001-01-01T00:00:00Z: treat it as "not set".
const optionalIsoDate = isoDate.transform((v) => (v.startsWith('0001-01-01') ? null : v));

export const uuid = z.string().uuid();

export const recordSchema = z.object({
  seq: z.number().int().positive(),
  at: isoDate,
  done: optionalIsoDate.optional().nullable(),
  method: z.string().max(16),
  path: z.string().max(2048),
  operation: z.string().max(64).optional().default(''),
  request_id: z.string().max(512).optional().default(''),
  fingerprint: z.string().max(128),
  rule: z.string().max(200).optional().default(''),
  fault: z.string().max(64).optional().default('none'),
  upstream_status: z.number().int().optional().default(0),
  issue: z.string().max(200).optional().default(''),
  object_id: z.string().max(200).optional().default(''),
  committed: z.boolean().optional().default(false),
  response_delivered: z.boolean().optional().default(false),
});
export type RecordIn = z.infer<typeof recordSchema>;

export const findingSchema = z.object({
  code: z.string().min(1).max(100),
  severity: z.enum(SEVERITIES),
  message: z.string().max(4000),
  path: z.string().max(2048).optional().default(''),
  operation: z.string().max(64).optional().default(''),
  fingerprint: z.string().max(128).optional().default(''),
  requests: z.array(z.number().int()).max(1000).nullable().optional().transform((v) => v ?? []),
  object_ids: z.array(z.string().max(200)).max(1000).nullable().optional().transform((v) => v ?? []),
  at: isoDate,
});
export type FindingIn = z.infer<typeof findingSchema>;

export const deliverySchema = z.object({
  event_id: z.string().max(200),
  type: z.string().max(200).optional().default(''),
  copy: z.number().int().min(0),
  received_order: z.number().int(),
  delivered_order: z.number().int().positive(),
  status: z.number().int().optional().default(0),
  error: z.string().max(2000).optional().default(''),
  at: isoDate,
});
export type DeliveryIn = z.infer<typeof deliverySchema>;

export const eventSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('request'), at: isoDate.optional(), request: recordSchema }),
  z.object({ kind: z.literal('finding'), at: isoDate.optional(), finding: findingSchema }),
  z.object({ kind: z.literal('webhook'), at: isoDate.optional(), webhook: deliverySchema }),
]);

export const batchSchema = z.object({
  seq: z.number().int().positive(),
  events: z.array(eventSchema).max(5000),
});

export const runMetaSchema = z.object({
  name: z.string().max(200).optional().default(''),
  seed: z.union([z.number().int().nonnegative(), z.string().regex(/^\d{1,20}$/)]).transform(String),
  upstream: z.string().max(500),
  scenario: z.unknown().optional().default({}),
  started_at: isoDate,
  engine_version: z.string().max(100).optional().default(''),
});

export const webhookSummarySchema = z.object({
  event_id: z.string(),
  type: z.string().optional().default(''),
  deliveries: z.number().int(),
  accepted_2xx: z.number().int(),
  reordered: z.boolean(),
});

export const finishSchema = z.object({
  finished_at: isoDate,
  findings: z.array(findingSchema).max(20000).nullable().transform((v) => v ?? []),
  faults_applied: z.record(z.string(), z.number().int()).nullable().optional().transform((v) => v ?? {}),
  webhooks: z.array(webhookSummarySchema).nullable().optional().transform((v) => v ?? []),
  webhook_notes: z.array(z.string()).nullable().optional().transform((v) => v ?? []),
  request_count: z.number().int().nonnegative(),
});

// The scenario editor validates against the same rules as `paychaos validate`.
export const ruleSchema = z.object({
  name: z.string().min(1).max(100),
  match: z
    .object({ method: z.string().max(10).optional(), path_prefix: z.string().max(500).optional() })
    .strict()
    .optional()
    .default({}),
  fault: z.enum(KNOWN_FAULTS),
  probability: z.number().min(0).max(1),
  max_hits: z.number().int().min(0).optional(),
  delay_ms: z.number().int().min(0).optional(),
}).strict();

export const scenarioConfigSchema = z
  .object({
    seed: z.number().int().nonnegative(),
    rules: z.array(ruleSchema).max(100),
    webhooks: z
      .object({
        duplicate_probability: z.number().min(0).max(1),
        duplicate_count: z.number().int().min(0),
        max_delay_ms: z.number().int().min(0),
        reorder_window_ms: z.number().int().min(0),
      })
      .strict()
      .optional(),
    mutating_paths: z.array(z.string()).optional(),
    request_id_paths: z.array(z.string()).optional(),
    min_backoff_ms: z.number().int().min(0).optional(),
    operation_id: z.array(z.string()).optional(),
  })
  .strict();

export const scenarioBodySchema = z.object({
  name: z.string().trim().min(1).max(100),
  config: scenarioConfigSchema,
});

export const projectBodySchema = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).optional().default(''),
});
export const projectPatchSchema = z
  .object({ name: z.string().trim().min(1).max(100), description: z.string().trim().max(500) })
  .partial()
  .strict()
  .refine((v) => v.name !== undefined || v.description !== undefined, { message: 'nothing to update' });
export const tokenBodySchema = z.object({ label: z.string().trim().max(100).optional().default('') });

export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  cursor: z.string().max(200).optional(),
});
