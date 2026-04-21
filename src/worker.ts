import os from 'node:os';
import { randomUUID } from 'node:crypto';
import PgBoss from 'pg-boss';
import { config } from './config.js';
import { prisma, disconnectAll } from './db.js';

// ─── Instance ID (stable for process lifetime, unique across workers) ────────
const instanceId = `${os.hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;

// ─── pg-boss (direct connection — session-level txns, LISTEN/NOTIFY) ─────────
const boss = new PgBoss({
  connectionString: config.DATABASE_URL_DIRECT,
  // pg-boss manages its own pool internally (~10 connections)
  monitorStateIntervalMinutes: 1,
  archiveCompletedAfterSeconds: 60 * 60 * 12, // 12 hours
});

boss.on('error', (error) => {
  console.error('pg-boss error:', error);
});

// ─── Heartbeat ───────────────────────────────────────────────────────────────
const HEARTBEAT_INTERVAL_MS = 30_000;
const REGISTERED_QUEUES = [
  'import-list',
  'process-run',
  'enrich-contact',
  'recovery-sweep',
  'cleanup-stale-data',
  'custom-field-cleanup',
];

async function upsertHeartbeat() {
  try {
    await prisma.workerHeartbeat.upsert({
      where: { instanceId },
      create: {
        instanceId,
        lastHeartbeat: new Date(),
        startedAt: new Date(),
        queues: REGISTERED_QUEUES,
      },
      update: {
        lastHeartbeat: new Date(),
      },
    });
  } catch (err) {
    console.error('Heartbeat upsert failed:', err);
  }
}

// ─── Register job handlers ───────────────────────────────────────────────────
async function registerHandlers() {
  // Create all queues first (pg-boss v10 requires queues to exist before scheduling)
  for (const queue of REGISTERED_QUEUES) {
    await boss.createQueue(queue);
  }

  // Register work handlers (must happen before schedule so queues exist)
  const { registerAllHandlers } = await import('./workers/register.js');
  await registerAllHandlers(boss);

  // Scheduled jobs (pg-boss cron) — queues already created above
  await boss.schedule('recovery-sweep', '*/5 * * * *', {}, {
    retryLimit: 1,
    retryDelay: 30,
    expireInMinutes: 5,
  });

  await boss.schedule('cleanup-stale-data', '0 3 * * *', {}, {
    retryLimit: 1,
    retryDelay: 60,
    expireInMinutes: 60,
  });

  console.log(`Worker ${instanceId} registered handlers for queues:`, REGISTERED_QUEUES);
}

// ─── Boot ────────────────────────────────────────────────────────────────────
async function start() {
  console.log(`Starting worker (instance: ${instanceId})...`);

  // boss.start() creates/updates the pgboss.* schema (migrations)
  await boss.start();
  console.log('pg-boss started (schema migrations applied)');

  // Initial heartbeat
  await upsertHeartbeat();

  // Heartbeat interval
  const heartbeatTimer = setInterval(upsertHeartbeat, HEARTBEAT_INTERVAL_MS);

  // Register handlers
  await registerHandlers();

  console.log(`Worker ${instanceId} is running`);

  // ─── Graceful shutdown ─────────────────────────────────────────────────
  async function shutdown() {
    console.log('Worker shutting down...');
    clearInterval(heartbeatTimer);
    await boss.stop({ graceful: true, timeout: 30_000 });
    await disconnectAll();
    process.exit(0);
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch((err) => {
  console.error('Worker failed to start:', err);
  process.exit(1);
});

export { boss, instanceId };
