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

/**
 * Bulk-insert many jobs in a single DB roundtrip.
 * Much faster than looping over sendJob() — e.g. 61K sequential sends take
 * ~20 min, vs ~2s for a bulk insert of the same jobs.
 */
export async function insertJobs(
  jobs: Array<{ name: string; data: Record<string, unknown>; options?: Record<string, unknown> }>
) {
  await ensureStarted();
  if (jobs.length === 0) return [];
  // pg-boss v10 insert() accepts an array of { name, data, singletonKey?, retryLimit?, ... }
  // all options go at the top level of each entry, NOT nested under 'options'
  const payload = jobs.map((j) => ({
    name: j.name,
    data: j.data,
    ...(j.options ?? {}),
  }));
  try {
    // Ensure queue exists for all distinct names
    const uniqueQueues = [...new Set(jobs.map((j) => j.name))];
    await Promise.all(uniqueQueues.map((q) => boss.createQueue(q)));
    return await (boss as any).insert(payload);
  } catch (err) {
    console.error(`Failed to bulk insert ${jobs.length} jobs:`, err);
    throw err;
  }
}

export { boss as sendOnlyBoss };
