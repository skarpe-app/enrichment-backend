import { prisma } from '../db.js';
import { sendJob } from '../queue.js';

/**
 * Recovery sweep per §11 — runs every 5 minutes.
 * Two sweeps:
 * 1. Orphaned `retrying` items (no job, locked_at IS NULL, updated_at > 10 min ago, run is active)
 * 2. Stuck-queuing runs (status='queuing', scope_materialized=false, updated_at < 1 hour ago)
 */
export async function handleRecoverySweep() {
  // 1. Orphaned retrying items → re-enqueue
  const orphanedItems = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT eri.id FROM enrichment_run_items eri
     JOIN enrichment_runs er ON er.id = eri.run_id
     WHERE eri.status = 'retrying'
       AND eri.locked_at IS NULL
       AND eri.updated_at < now() - interval '10 minutes'
       AND er.status IN ('processing')
     LIMIT 100`
  );

  for (const item of orphanedItems) {
    await sendJob('enrich-contact', { runItemId: item.id }, {
      singletonKey: item.id,
      retryLimit: 3,
      retryDelay: 30,
      retryBackoff: true,
      expireInMinutes: 10,
    });
  }

  if (orphanedItems.length > 0) {
    console.log(`recovery-sweep: re-enqueued ${orphanedItems.length} orphaned retrying items`);
  }

  // 2. Stuck-queuing runs → auto-stop (1-hour SLA)
  const stuckResult = await prisma.$executeRawUnsafe(
    `UPDATE enrichment_runs
     SET status = 'stopped',
         stopped_at = now(),
         error_message = coalesce(error_message, 'Run auto-stopped after 1 hour of inactivity during fan-out.')
     WHERE status = 'queuing'
       AND scope_materialized = false
       AND updated_at < now() - interval '1 hour'`
  );

  if (typeof stuckResult === 'number' && stuckResult > 0) {
    console.log(`recovery-sweep: auto-stopped ${stuckResult} stuck-queuing runs`);
  }
}
