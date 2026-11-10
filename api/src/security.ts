import type { FastifyInstance, FastifyRequest } from 'fastify';
import { HttpError } from './errors.js';

/**
 * Response headers for every route. The dashboard is a same-origin SPA built
 * by Vite with no inline scripts, so a strict CSP costs nothing.
 */
export const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
    "connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
};

export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onSend', async (_req, reply, payload) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
      if (!reply.hasHeader(k)) reply.header(k, v);
    }
    return payload;
  });
}

/**
 * Slows down token guessing. Each client address may fail authentication
 * `max` times per `windowMs`; after that every authenticated route answers
 * 429 until the window passes, even with a correct token, so a guesser
 * learns nothing from the answer. Successful requests are not counted, so a
 * busy engine streaming batches is never limited.
 *
 * State is per API instance and in memory. With N instances a guesser gets
 * N × max attempts per window, which is still far too few for a 256-bit
 * token; the point is to stop log flooding and casual brute force, not to be
 * a distributed rate limiter.
 */
export class AuthFailureLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max = 20,
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
    private readonly maxTracked = 10_000,
  ) {}

  /** Throws 429 if the address is currently blocked. */
  check(ip: string): void {
    const h = this.hits.get(ip);
    if (!h) return;
    if (h.resetAt <= this.now()) {
      this.hits.delete(ip);
      return;
    }
    if (h.count >= this.max) {
      const retry = Math.ceil((h.resetAt - this.now()) / 1000);
      throw new HttpError(429, `too many failed authentication attempts; retry in ${retry}s`);
    }
  }

  fail(ip: string): void {
    const t = this.now();
    const h = this.hits.get(ip);
    if (!h || h.resetAt <= t) {
      if (this.hits.size >= this.maxTracked) this.prune(t);
      this.hits.set(ip, { count: 1, resetAt: t + this.windowMs });
    } else {
      h.count++;
    }
  }

  private prune(t: number): void {
    for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
    // Still full of live entries: drop the oldest rather than grow unbounded.
    while (this.hits.size >= this.maxTracked) {
      const first = this.hits.keys().next().value;
      if (first === undefined) break;
      this.hits.delete(first);
    }
  }

  get size(): number {
    return this.hits.size;
  }
}

/** Runs an auth check under the limiter: blocked → 429; a 401 counts as a failure. */
export async function limited<T>(limiter: AuthFailureLimiter, req: FastifyRequest, fn: () => T | Promise<T>): Promise<T> {
  limiter.check(req.ip);
  try {
    return await fn();
  } catch (err) {
    if (err instanceof HttpError && err.statusCode === 401) limiter.fail(req.ip);
    throw err;
  }
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * Refuses to start an open dashboard on a non-loopback address. Ingest is
 * always token-protected, but without ADMIN_TOKEN anyone who can reach the
 * port can read every run and mint ingest tokens.
 */
export function checkStartupSecurity(env: { host: string; adminToken?: string; allowOpen?: boolean }): string[] {
  const problems: string[] = [];
  if (env.adminToken !== undefined && env.adminToken.length < 16) {
    problems.push('ADMIN_TOKEN must be at least 16 characters (try: openssl rand -hex 24)');
  }
  if (!env.adminToken && !LOOPBACK.has(env.host) && !env.allowOpen) {
    problems.push(
      `refusing to serve an unauthenticated dashboard on ${env.host}: set ADMIN_TOKEN, bind HOST=127.0.0.1, ` +
        'or set ALLOW_OPEN_DASHBOARD=true if the port is only reachable from this machine',
    );
  }
  return problems;
}
