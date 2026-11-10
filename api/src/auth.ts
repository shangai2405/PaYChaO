import { createHash, randomBytes } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type pg from 'pg';
import { HttpError } from './errors.js';

export const TOKEN_PREFIX = 'pct_';

/** A new ingest token: 32 random bytes, base64url, with a recognisable prefix. */
export function newToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return null;
  const t = h.slice(7).trim();
  return t || null;
}

/**
 * Resolves the ingest token on a request to its project. Only the token's
 * hash is ever compared or stored; the lookup is by unique index, so its
 * timing does not depend on how much of a guess matches.
 */
export async function projectForToken(pool: pg.Pool, req: FastifyRequest): Promise<string> {
  const token = bearer(req);
  if (!token) throw new HttpError(401, 'missing bearer token');
  // One round trip: resolve the token and, at most once a minute, stamp
  // last_used_at so the dashboard can show which tokens are still in use.
  const { rows } = await pool.query<{ project_id: string }>(
    `WITH t AS (
       SELECT id, project_id, last_used_at FROM ingest_tokens WHERE token_hash = $1 AND revoked_at IS NULL
     ), touched AS (
       UPDATE ingest_tokens i SET last_used_at = now() FROM t
       WHERE i.id = t.id AND (t.last_used_at IS NULL OR t.last_used_at < now() - interval '60 seconds')
     )
     SELECT project_id FROM t`,
    [hashToken(token)],
  );
  const row = rows[0];
  if (!row) throw new HttpError(401, 'invalid or revoked token');
  return row.project_id;
}

/**
 * Optional protection for the dashboard API. When ADMIN_TOKEN is set, every
 * non-ingest route needs `Authorization: Bearer <ADMIN_TOKEN>` (or, for the
 * browser's EventSource, which cannot set headers, `?access_token=`).
 */
export function checkAdmin(req: FastifyRequest, adminToken: string | undefined): void {
  if (!adminToken) return;
  const given = bearer(req) ?? (req.query as Record<string, string> | undefined)?.access_token ?? '';
  const a = hashToken(given);
  const b = hashToken(adminToken);
  if (!a.equals(b)) throw new HttpError(401, 'admin token required');
}
