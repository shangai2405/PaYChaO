import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { EventHub, RunEvent } from '../events.js';

/**
 * Server-Sent Events: GET /api/stream?project=<id>[&run=<id>]
 *
 * Each API instance holds one LISTEN connection (EventHub); every browser
 * connected to that instance gets the notifications that match its filter.
 * Ingest may happen on a different instance: Postgres delivers the NOTIFY to
 * all listeners, so any instance can serve any stream.
 */
export async function streamRoutes(app: FastifyInstance, hub: EventHub): Promise<void> {
  app.get('/api/stream', async (req, reply) => {
    const q = z.object({ project: z.string().uuid().optional(), run: z.string().uuid().optional() }).parse(req.query);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const onEvent = (ev: RunEvent) => {
      if (q.project && ev.project_id !== q.project) return;
      if (q.run && ev.run_id !== q.run) return;
      res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
    };
    hub.on('event', onEvent);
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    ping.unref();
    req.raw.on('close', () => {
      clearInterval(ping);
      hub.off('event', onEvent);
    });
  });
}
