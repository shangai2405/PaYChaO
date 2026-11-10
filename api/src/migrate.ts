import { createPool, migrate } from './db.js';

const pool = createPool();
migrate(pool)
  .then((applied) => {
    console.log(applied.length ? `applied: ${applied.join(', ')}` : 'database is up to date');
    return pool.end();
  })
  .catch(async (err) => {
    console.error(err);
    await pool.end();
    process.exit(1);
  });
