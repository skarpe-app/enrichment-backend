import type PgBoss from 'pg-boss';
import { handleImportList } from './import-list.worker.js';
import { handleProcessRun } from './process-run.worker.js';
import { enrichContact } from '../enrichment/pipeline.js';
import { handleRecoverySweep } from './recovery-sweep.worker.js';
import { handleCleanupStaleData } from './cleanup.worker.js';

/**
 * Register all job handlers with pg-boss.
 * Called from worker.ts after boss.start().
 *
 * pg-boss v10: boss.work() handler receives an array of jobs.
 * teamSize controls concurrency (replaces teamConcurrency from v9).
 */
export async function registerAllHandlers(boss: PgBoss) {
  // import-list: concurrency 1, per §11
  await boss.work('import-list', { teamSize: 1 } as any, async (jobs: any[]) => {
    for (const job of jobs) {
      await handleImportList(job as { data: { listId: string } });
    }
  });

  // process-run: concurrency 2, per §11
  await boss.work('process-run', { teamSize: 2 } as any, async (jobs: any[]) => {
    for (const job of jobs) {
      await handleProcessRun(job as { data: { runId: string } });
    }
  });

  // enrich-contact: concurrency 30 (bumped from 15 for faster throughput).
  // - teamSize: 30 items fetched per polling cycle
  // - teamConcurrency: 30 items processed in PARALLEL within the batch
  // - pollingIntervalSeconds: 0.5 — poll 4× faster than default 2s
  // Tuned for OpenAI Tier 1/2 (~500 RPM, 200K TPM on gpt-4.1-mini).
  // pg-boss v10: use `batchSize` to fetch N jobs per poll. The handler then runs
  // them concurrently with Promise.all. (`teamSize`/`teamConcurrency` were v9 and
  // are silently ignored in v10 — that's why we were stuck at active=1.)
  await boss.work(
    'enrich-contact',
    { batchSize: 30, pollingIntervalSeconds: 0.5 } as any,
    async (jobs: any[]) => {
      await Promise.all(
        jobs.map((job) => enrichContact((job.data as { runItemId: string }).runItemId))
      );
    }
  );

  // custom-field-cleanup: concurrency 1
  await boss.work('custom-field-cleanup', { teamSize: 1 } as any, async (jobs: any[]) => {
    for (const job of jobs) {
      const { userId, fieldKey } = job.data as { userId: string; fieldKey: string };
      await handleCustomFieldCleanup(userId, fieldKey);
    }
  });

  // Scheduled jobs
  await boss.work('recovery-sweep', { teamSize: 1 } as any, async () => {
    await handleRecoverySweep();
  });

  await boss.work('cleanup-stale-data', { teamSize: 1 } as any, async () => {
    await handleCleanupStaleData();
  });

  console.log('All job handlers registered');
}

async function handleCustomFieldCleanup(userId: string, fieldKey: string) {
  const { prisma } = await import('../db.js');

  const lists = await prisma.contactList.findMany({
    where: { userId },
    select: { id: true },
  });

  for (const list of lists) {
    await prisma.$executeRawUnsafe(
      `UPDATE contacts SET custom_fields = custom_fields - $1 WHERE list_id = $2::uuid AND custom_fields ? $1`,
      fieldKey,
      list.id
    );
  }

  console.log(`custom-field-cleanup: removed key "${fieldKey}" for user ${userId}`);
}
