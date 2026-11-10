// k6 load test for the ingest path, the part of the API that must keep up
// with engines streaming runs.
//
//   k6 run -e API=http://127.0.0.1:3000 load/ingest.js
//
// Each virtual user creates a run, then posts numbered batches of 200
// request events to it. Every 10th batch is sent twice, as a lost response
// would cause, and must come back as a duplicate rather than being stored
// again. Record the summary, and the machine it ran on, in the README.
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import exec from 'k6/execution';

const API = __ENV.API || 'http://127.0.0.1:3000';
const BATCH = Number(__ENV.BATCH || 200);
const duplicates = new Counter('duplicate_batches_detected');

export const options = {
  scenarios: {
    ingest: { executor: 'constant-vus', vus: Number(__ENV.VUS || 20), duration: __ENV.DURATION || '1m' },
  },
  thresholds: {
    'http_req_failed': ['rate<0.01'],
    'http_req_duration{name:batch}': ['p(95)<250'],
  },
};

const json = { 'Content-Type': 'application/json' };

export function setup() {
  const headers = __ENV.ADMIN_TOKEN ? { ...json, Authorization: `Bearer ${__ENV.ADMIN_TOKEN}` } : json;
  const p = http.post(`${API}/api/projects`, JSON.stringify({ name: `load-${Date.now()}` }), { headers }).json();
  const t = http.post(`${API}/api/projects/${p.id}/tokens`, JSON.stringify({ label: 'k6' }), { headers }).json();
  return { token: t.token };
}

function uuid() {
  const h = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < 32; i++) s += h[Math.floor(Math.random() * 16)];
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-8${s.slice(17, 20)}-${s.slice(20, 32)}`;
}

let runId = null;
let seq = 0;

export default function (data) {
  const headers = { ...json, Authorization: `Bearer ${data.token}` };
  if (!runId) {
    runId = uuid();
    const r = http.put(`${API}/api/ingest/runs/${runId}`, JSON.stringify({
      name: `k6 vu ${exec.vu.idInTest}`, seed: 7, upstream: 'mock', started_at: new Date().toISOString(),
    }), { headers, tags: { name: 'run' } });
    check(r, { 'run created': (x) => x.status === 201 });
  }
  seq++;
  const now = new Date().toISOString();
  const events = [];
  for (let i = 0; i < BATCH; i++) {
    const n = (seq - 1) * BATCH + i + 1;
    events.push({
      kind: 'request',
      request: {
        seq: n, at: now, done: now, method: 'POST', path: '/v2/checkout/orders', operation: 'create_order',
        request_id: '', fingerprint: `fp${n % 50}`, fault: n % 7 === 0 ? 'drop_after_commit' : 'none',
        upstream_status: 201, object_id: `ORDER${n}`, committed: true, response_delivered: false,
      },
    });
  }
  const body = JSON.stringify({ seq, events });
  const r = http.post(`${API}/api/ingest/runs/${runId}/batches`, body, { headers, tags: { name: 'batch' } });
  check(r, { 'batch stored': (x) => x.status === 201 });
  if (seq % 10 === 0) {
    const again = http.post(`${API}/api/ingest/runs/${runId}/batches`, body, { headers, tags: { name: 'batch_retry' } });
    if (check(again, { 'retry is a duplicate': (x) => x.status === 200 && x.json('duplicate') === true })) duplicates.add(1);
  }
}
