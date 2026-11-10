import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { createPool, migrate } from './db.js';
import { EventHub } from './events.js';
import { checkStartupSecurity } from './security.js';

const here = dirname(fileURLToPath(import.meta.url));

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const host = process.env.HOST ?? '127.0.0.1';
  const adminToken = process.env.ADMIN_TOKEN || undefined;
  const problems = checkStartupSecurity({ host, adminToken, allowOpen: process.env.ALLOW_OPEN_DASHBOARD === 'true' });
  if (problems.length) {
    // A configuration problem: say what to change, without a stack trace.
    console.error(problems.join('\n'));
    process.exit(1);
  }
  const pool = createPool(url);
  if (process.env.MIGRATE_ON_START !== 'false') {
    const applied = await migrate(pool);
    if (applied.length) console.log(`applied migrations: ${applied.join(', ')}`);
  }
  const hub = new EventHub(url);
  await hub.start();
  const app = await buildApp({
    pool,
    hub,
    adminToken,
    trustProxy: process.env.TRUST_PROXY === 'true',
    staticDir: process.env.STATIC_DIR ?? join(here, '..', '..', 'web', 'dist'),
    logger: process.env.LOG_REQUESTS !== 'false',
  });
  const port = Number(process.env.PORT ?? 3000);
  await app.listen({ port, host });

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await app.close();
    await hub.stop();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
