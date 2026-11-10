import { EventEmitter } from 'node:events';
import pg from 'pg';

export const CHANNEL = 'paychaos_events';

/** What ingest announces with NOTIFY after each committed write. */
export interface RunEvent {
  type: 'run.started' | 'run.batch' | 'run.finished';
  run_id: string;
  project_id: string;
  requests?: number;
  findings?: number;
  webhooks?: number;
}

/**
 * EventHub holds one dedicated connection per API instance that LISTENs on
 * the channel and fans each notification out to that instance's SSE clients.
 * Ingest can land on any instance and any instance can serve any browser, so
 * no sticky sessions are needed. If the connection drops it reconnects with
 * backoff; browsers keep their SSE streams and miss only what was sent while
 * it was down (the dashboard refetches on reconnect).
 */
export class EventHub extends EventEmitter {
  private client: pg.Client | null = null;
  private stopped = false;
  private retryMs = 250;

  constructor(private readonly connectionString: string) {
    super();
    this.setMaxListeners(0);
  }

  async start(): Promise<void> {
    await this.connect();
  }

  private async connect(): Promise<void> {
    const client = new pg.Client({ connectionString: this.connectionString });
    client.on('notification', (msg) => {
      if (msg.channel !== CHANNEL || !msg.payload) return;
      try {
        this.emit('event', JSON.parse(msg.payload) as RunEvent);
      } catch {
        /* ignore malformed payloads */
      }
    });
    client.on('error', () => this.reconnect());
    client.on('end', () => this.reconnect());
    await client.connect();
    await client.query(`LISTEN ${CHANNEL}`);
    this.client = client;
    this.retryMs = 250;
  }

  private reconnect(): void {
    if (this.stopped || !this.client) return;
    const old = this.client;
    this.client = null;
    old.removeAllListeners();
    old.end().catch(() => {});
    const wait = this.retryMs;
    this.retryMs = Math.min(this.retryMs * 2, 10_000);
    setTimeout(() => {
      if (this.stopped) return;
      this.connect().catch(() => {
        this.client = old; // so the next reconnect() runs
        this.reconnect();
      });
    }, wait).unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const c = this.client;
    this.client = null;
    if (c) {
      c.removeAllListeners();
      await c.end().catch(() => {});
    }
  }
}

/** Sends a notification as part of the caller's transaction. */
export async function notify(q: pg.ClientBase, ev: RunEvent): Promise<void> {
  await q.query('SELECT pg_notify($1, $2)', [CHANNEL, JSON.stringify(ev)]);
}
