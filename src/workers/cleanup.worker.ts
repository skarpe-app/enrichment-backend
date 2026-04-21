import { prisma } from '../db.js';
import { supabaseAdmin } from '../services/supabase.js';

const BUCKET = 'csv-uploads';

/**
 * Cleanup stale data per §17 — runs daily.
 */
export async function handleCleanupStaleData() {
  // 1. run_events older than 30 days
  const eventsDeleted = await prisma.$executeRawUnsafe(
    `DELETE FROM run_events WHERE created_at < now() - interval '30 days'`
  );
  console.log(`cleanup: deleted ${eventsDeleted} old run_events`);

  // 2. proxy_attempt_events older than 30 days
  const proxyEventsDeleted = await prisma.$executeRawUnsafe(
    `DELETE FROM proxy_attempt_events WHERE created_at < now() - interval '30 days'`
  );
  console.log(`cleanup: deleted ${proxyEventsDeleted} old proxy_attempt_events`);

  // 3. worker_heartbeats older than 7 days
  const heartbeatsDeleted = await prisma.$executeRawUnsafe(
    `DELETE FROM worker_heartbeats WHERE created_at < now() - interval '7 days'`
  );
  console.log(`cleanup: deleted ${heartbeatsDeleted} old worker_heartbeats`);

  // 4. Failed import CSVs older than 7 days
  const failedLists = await prisma.contactList.findMany({
    where: {
      status: 'import_failed',
      updatedAt: { lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
    },
    select: { id: true, userId: true },
  });
  for (const list of failedLists) {
    const path = `${list.userId}/${list.id}/original.csv`;
    await supabaseAdmin.storage.from(BUCKET).remove([path]).catch(() => {});
  }
  if (failedLists.length > 0) console.log(`cleanup: deleted ${failedLists.length} failed import CSVs`);

  // 5. Soft-deleted lists older than 1 year → billing snapshot + hard delete per §5.16
  const oldDeletedLists = await prisma.contactList.findMany({
    where: {
      deletedAt: { lt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000) },
    },
    select: { id: true, userId: true, name: true, deletedAt: true },
  });

  for (const list of oldDeletedLists) {
    // Single transaction: snapshot + delete (idempotent via ON CONFLICT DO NOTHING)
    await prisma.$executeRawUnsafe(
      `INSERT INTO billing_snapshots (id, user_id, list_id, list_name, total_runs, total_items, total_cost_usd, total_input_tokens, total_output_tokens, deleted_at, purged_at)
       SELECT gen_random_uuid(), $1::uuid, $2::uuid, $3, COUNT(*)::int, COALESCE(SUM(total_items), 0)::int,
              COALESCE(SUM(total_cost_usd), 0), COALESCE(SUM(total_input_tokens), 0)::int,
              COALESCE(SUM(total_output_tokens), 0)::int, $4, now()
       FROM enrichment_runs WHERE list_id = $2::uuid
       ON CONFLICT (list_id) DO NOTHING`,
      list.userId, list.id, list.name, list.deletedAt
    );
    await prisma.contactList.delete({ where: { id: list.id } });
  }
  if (oldDeletedLists.length > 0) console.log(`cleanup: purged ${oldDeletedLists.length} soft-deleted lists (1-year retention)`);

  // 6. Orphaned pending lists older than 7 days
  const orphanedPending = await prisma.contactList.findMany({
    where: {
      status: 'pending',
      updatedAt: { lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
    },
    select: { id: true, userId: true },
  });
  for (const list of orphanedPending) {
    const path = `${list.userId}/${list.id}/original.csv`;
    await supabaseAdmin.storage.from(BUCKET).remove([path]).catch(() => {});
    await prisma.contactList.delete({ where: { id: list.id } });
  }
  if (orphanedPending.length > 0) console.log(`cleanup: deleted ${orphanedPending.length} orphaned pending lists`);
}
