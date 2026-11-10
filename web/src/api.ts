// Typed client for the paychaos API. Shapes mirror api/src/routes/*.ts.

export type Severity = 'HIGH' | 'MEDIUM' | 'LOW';

export interface LatestRun {
  id: string;
  name: string;
  started_at: string;
  high: number;
  medium: number;
  low: number;
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  created_at: string;
  run_count?: number;
  last_run_at?: string | null;
  latest?: LatestRun | null;
}

export type HealthStatus = 'no_runs' | 'passing' | 'warning' | 'failing';

export interface TrendRun extends LatestRun {
  seed: string;
  finished_at: string | null;
  request_count: number;
}

export interface Health {
  project: Project;
  status: HealthStatus;
  runs: TrendRun[];
  codes: { code: string; severity: Severity; occurrences: number; runs: number }[];
  latest: TrendRun | null;
  change: {
    base: string;
    current: string;
    regressed: boolean;
    worst_new: Severity | null;
    new_findings: number;
    fixed_findings: number;
    comparable: boolean;
  } | null;
}

export interface Run {
  id: string;
  project_id: string;
  name: string;
  seed: string;
  upstream: string;
  engine_version: string;
  status: 'running' | 'finished';
  started_at: string;
  finished_at: string | null;
  request_count: number;
  high: number;
  medium: number;
  low: number;
  faults_applied: Record<string, number>;
  scenario?: unknown;
  webhooks?: WebhookSummary[];
  webhook_notes?: string[];
}

export interface Finding {
  id: string;
  code: string;
  severity: Severity;
  message: string;
  path: string;
  operation: string;
  fingerprint: string;
  requests: number[];
  object_ids: string[];
  at: string;
  final: boolean;
}

export interface Attempt {
  seq: number;
  at: string;
  done: string | null;
  method: string;
  path: string;
  request_id: string;
  fault: string;
  upstream_status: number;
  issue: string;
  object_id: string;
  committed: boolean;
  response_delivered: boolean;
}

export interface Operation {
  fingerprint: string;
  operation: string;
  path: string;
  attempts: number;
  created: number;
  timeline: Attempt[];
  findings: { code: string; severity: Severity }[];
}

export interface WebhookSummary {
  event_id: string;
  type: string;
  deliveries: number;
  accepted_2xx: number;
  reordered: boolean;
}

export interface Delivery {
  delivered_order: number;
  event_id: string;
  type: string;
  copy: number;
  received_order: number;
  status: number;
  error: string;
  at: string;
}

export interface Token {
  id: string;
  label: string;
  prefix: string;
  created_at: string;
  last_used_at?: string | null;
  revoked_at: string | null;
  token?: string;
}

export interface Scenario {
  id: string;
  name: string;
  config: unknown;
  created_at: string;
  updated_at: string;
}

export interface CompareRow {
  severity: Severity;
  code: string;
  path: string;
  baseline: number;
  current: number;
  delta: number;
}

export interface Comparison {
  base: Run;
  current: Run;
  warnings: string[];
  rows: CompareRow[];
  regressed: boolean;
  worst_new: Severity | null;
}

export interface Issue {
  path: string;
  message: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly issues: Issue[] = [],
  ) {
    super(message);
  }
}

const ADMIN_KEY = 'paychaos.adminToken';

export function adminToken(): string {
  try {
    return localStorage.getItem(ADMIN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setAdminToken(v: string): void {
  try {
    if (v) localStorage.setItem(ADMIN_KEY, v);
    else localStorage.removeItem(ADMIN_KEY);
  } catch {
    /* private mode: the token lasts for this page only */
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('Content-Type', 'application/json');
  const tok = adminToken();
  if (tok) headers.set('Authorization', `Bearer ${tok}`);
  const res = await fetch(path, { ...init, headers });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // A proxy's HTML error page, for instance: report the status, not a parse error.
    if (!res.ok) throw new ApiError(res.status, res.statusText || `request failed (${res.status})`);
    throw new ApiError(res.status, 'the server sent a response that is not JSON');
  }
  if (!res.ok) {
    const msg = body?.error ?? res.statusText;
    throw new ApiError(res.status, body?.request_id ? `${msg} (request ${body.request_id})` : msg, body?.issues ?? []);
  }
  return body as T;
}

export const post = <T>(path: string, body: unknown) => api<T>(path, { method: 'POST', body: JSON.stringify(body) });
export const put = <T>(path: string, body: unknown) => api<T>(path, { method: 'PUT', body: JSON.stringify(body) });
export const patch = <T>(path: string, body: unknown) => api<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
export const del = (path: string) => api<void>(path, { method: 'DELETE' });

export type ExportFormat = 'json' | 'junit' | 'markdown';

/**
 * Downloads a run export. Fetched rather than linked so the admin token
 * travels in a header, never in a URL that could end up in history or logs.
 */
export async function downloadExport(runId: string, format: ExportFormat): Promise<void> {
  const headers = new Headers();
  const tok = adminToken();
  if (tok) headers.set('Authorization', `Bearer ${tok}`);
  const res = await fetch(`/api/runs/${runId}/export?format=${format}`, { headers });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new ApiError(res.status, body?.error ?? res.statusText);
  }
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? `paychaos-${runId}.${format}`;
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** URL for an EventSource, which cannot send headers. */
export function streamURL(params: Record<string, string>): string {
  const q = new URLSearchParams(params);
  const tok = adminToken();
  if (tok) q.set('access_token', tok);
  return `/api/stream?${q}`;
}
