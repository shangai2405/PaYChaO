import { existsSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import type pg from 'pg';
import { ZodError } from 'zod';
import { checkAdmin } from './auth.js';
import { HttpError } from './errors.js';
import type { EventHub } from './events.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { ingestRoutes } from './routes/ingest.js';
import { streamRoutes } from './routes/stream.js';
import { exportRoutes } from './routes/export.js';
import { AuthFailureLimiter, limited, registerSecurityHeaders } from './security.js';

export interface AppOptions {
  pool: pg.Pool;
  hub: EventHub;
  /** When set, dashboard routes require it (ingest routes use ingest tokens). */
  adminToken?: string;
  /** Built dashboard (web/dist) to serve at /, if present. */
  staticDir?: string;
  logger?: boolean;
  bodyLimit?: number;
  /** Trust X-Forwarded-For from a reverse proxy (for the auth limiter's client address). */
  trustProxy?: boolean;
  /** Failed-authentication limiter; one is created when not given. */
  authLimiter?: AuthFailureLimiter;
}

/**
 * Builds the API. It holds no state between requests: everything lives in
 * Postgres, and live updates go through LISTEN/NOTIFY, so any number of
 * instances can run behind a plain load balancer.
 */
export async function buildApp(opt: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opt.logger
      ? {
          serializers: {
            // Never log headers (Authorization) or the SSE access_token.
            req: (r) => ({ method: r.method, url: r.url.replace(/access_token=[^&]*/g, 'access_token=***') }),
          },
        }
      : false,
    bodyLimit: opt.bodyLimit ?? 8 * 1024 * 1024,
    trustProxy: opt.trustProxy ?? false,
    // Live streams (SSE) never end on their own; close them on shutdown
    // instead of waiting for every browser tab to go away.
    forceCloseConnections: true,
  });
  const limiter = opt.authLimiter ?? new AuthFailureLimiter();
  registerSecurityHeaders(app);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: 'invalid request',
        issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) return reply.code(status).send({ error: (err as Error).message });
    if ((err as { code?: string }).code === '22007' || (err as { code?: string }).code === '22P02') {
      return reply.code(400).send({ error: 'invalid value' });
    }
    app.log.error(err);
    // The request id ties the browser's error to the server log line.
    return reply.code(500).send({ error: 'internal error', request_id: _req.id });
  });

  app.addHook('onRequest', async (req) => {
    const url = req.url;
    if (url.startsWith('/api/') && !url.startsWith('/api/ingest/') && url !== '/api/health') {
      await limited(limiter, req, () => checkAdmin(req, opt.adminToken));
    }
  });

  // Health checks run every few seconds; keep them out of the request log.
  app.get('/api/health', { logLevel: 'silent' }, async () => {
    await opt.pool.query('SELECT 1');
    return { ok: true };
  });

  await ingestRoutes(app, opt.pool, limiter);
  await dashboardRoutes(app, opt.pool);
  await exportRoutes(app, opt.pool);
  await streamRoutes(app, opt.hub);

  if (opt.staticDir && existsSync(opt.staticDir)) {
    await app.register(fastifyStatic, {
      root: opt.staticDir,
      wildcard: false,
      cacheControl: false,
      // Vite puts a content hash in every asset name, so they never change.
      setHeaders: (res, filePath) => {
        if (filePath.includes(`${'/'}assets${'/'}`)) res.setHeader('cache-control', 'public, max-age=31536000, immutable');
        else res.setHeader('cache-control', 'no-cache');
      },
    });
    // Client-side routes fall back to index.html.
    app.setNotFoundHandler((req, reply) => {
      // Only page routes fall back. A missing asset (an old hashed bundle
      // after a deploy) must 404, not come back as HTML with a 200.
      const path = req.url.split('?')[0]!;
      const isAsset = path.startsWith('/assets/') || /\.[a-z0-9]+$/i.test(path);
      if (req.method === 'GET' && !path.startsWith('/api/') && !isAsset) {
        // The shell must never be cached, or a deploy leaves browsers on stale bundles.
        reply.header('cache-control', 'no-cache');
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'not found' });
    });
  }
  return app;
}
