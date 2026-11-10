import { HttpError } from './errors.js';

/**
 * Keyset cursor for lists ordered by (started_at DESC, id DESC). The cursor is
 * the last row's sort key, so the next page is
 *   WHERE (started_at, id) < ($ts, $id)
 * which an index on (project_id, started_at DESC, id DESC) answers directly at
 * any depth, unlike OFFSET, which reads and discards every skipped row.
 */
export interface Cursor {
  ts: string;
  id: string;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(`${c.ts}|${c.id}`, 'utf8').toString('base64url');
}

export function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  const s = Buffer.from(raw, 'base64url').toString('utf8');
  const i = s.lastIndexOf('|');
  const ts = s.slice(0, i);
  const id = s.slice(i + 1);
  // ts is Postgres's own text form of the timestamptz (microsecond precision,
  // which a JS Date would truncate and so skip or repeat rows).
  const tsOk = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:?\d{2})?|Z)?$/.test(ts);
  if (i < 1 || !tsOk || !/^[0-9a-f-]{36}$/i.test(id)) {
    throw new HttpError(400, 'invalid cursor');
  }
  return { ts, id };
}
