import PgBoss from 'pg-boss';
import { config } from './config.js';

/**
 * pg-boss client for the web service (send-only — no work subscribers).
 * Calls boss.start() to initialize the connection pool (required in pg-boss v10).
 * Does NOT register any work handlers — only sends jobs.
 * Schema migrations are idempotent so this is safe even if worker starts first.
 */
const boss = new PgBoss({
  connectionString: config.DATABASE_URL_DIRECT,
});

boss.on('error', (error) => {
  console.error('pg-boss send client error:', error);
});

let started = false;

async function ensureStarted() {
  if (!started) {
    await boss.start();
    started = true;
  }
}

export async function sendJob(
  queue: string,
  data: Record<string, unknown>,
  options?: Record<string, unknown>
) {
  await ensureStarted();
  try {
    // Ensure queue exists before sending (pg-boss v10 requirement)
    await boss.createQueue(queue);
    const jobId = await boss.send(queue, data, options as any);
    return jobId;
  } catch (err) {
    console.error(`Failed to queue job on ${queue}:`, err);
    throw err;
  }
}

export { boss as sendOnlyBoss };
