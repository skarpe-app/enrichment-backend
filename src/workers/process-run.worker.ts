import { prisma } from '../db.js';
import { insertJobs } from '../queue.js';

const BATCH_SIZE = 5000;

/**
 * Process-run worker per §11.
 * Resolves scope → materializes RunItems → fans out enrich-contact jobs.
 */
export async function handleProcessRun(job: { data: { runId: string } }) {
  const { runId } = job.data;
  const startedAt = Date.now();

  const run = await prisma.enrichmentRun.findUnique({ where: { id: runId } });
  if (!run) return;
  if (run.status === 'stopped') return;

  console.log(`[process-run] START run=${runId.slice(0, 8)} scope=${run.scopeType} list=${run.listId.slice(0, 8)}`);

  try {
    // ─── 1-2. Resolve contacts from scope ─────────────────────────────────
    let contactIds: string[];

    if (run.scopeType === 'all') {
      const contacts = await prisma.contact.findMany({
        where: { listId: run.listId },
        select: { id: true },
      });
      contactIds = contacts.map((c) => c.id);
    } else if (run.scopeType === 'selected') {
      contactIds = run.selectedContactIds;
    } else {
      // filtered — re-apply filter_snapshot per §5.7
      const snapshot = run.filterSnapshot as { search?: string; filters?: Array<{ field: string; op: string; value: unknown }> } | null;
      const where: any = { listId: run.listId };

      if (snapshot?.search) {
        where.OR = [
          { email: { contains: snapshot.search, mode: 'insensitive' } },
          { name: { contains: snapshot.search, mode: 'insensitive' } },
          { companyName: { contains: snapshot.search, mode: 'insensitive' } },
        ];
      }

      // Apply basic filters (status/industry filters require joins — simplified for v1)
      const contacts = await prisma.contact.findMany({
        where,
        select: { id: true },
      });
      contactIds = contacts.map((c) => c.id);
    }

    const resolvedCount = contactIds.length;

    // ─── 3-4. Zero-item check ─────────────────────────────────────────────
    if (resolvedCount === 0) {
      await prisma.enrichmentRun.update({
        where: { id: runId },
        data: {
          totalItems: 0,
          scopeMaterialized: true,
          status: 'completed',
          completedAt: new Date(),
        },
      });
      await prisma.runEvent.create({
        data: {
          runId,
          step: 'skip',
          status: 'skipped',
          message: 'No contacts matched the selected scope',
        },
      });
      return;
    }

    // ─── 5. Set total_items + started_at ──────────────────────────────────
    await prisma.enrichmentRun.update({
      where: { id: runId },
      data: {
        totalItems: resolvedCount,
        ...(run.startedAt ? {} : { startedAt: new Date() }),
      },
    });

    // ─── 6. Batch fan-out ─────────────────────────────────────────────────
    console.log(`[process-run] fanning out ${contactIds.length} items in batches of ${BATCH_SIZE}...`);
    for (let i = 0; i < contactIds.length; i += BATCH_SIZE) {
      // Check if stopped mid-fan-out
      const currentRun = await prisma.enrichmentRun.findUnique({
        where: { id: runId },
        select: { status: true },
      });
      if (currentRun?.status === 'stopped') {
        console.log(`[process-run] STOPPED mid-fan-out at batch ${i}/${contactIds.length}`);
        return;
      }

      const batch = contactIds.slice(i, i + BATCH_SIZE);
      const batchStart = Date.now();

      // Create RunItems (idempotent via unique constraint)
      await prisma.enrichmentRunItem.createMany({
        data: batch.map((contactId) => ({
          runId,
          contactId,
        })),
        skipDuplicates: true,
      });

      // Re-query ALL items for this batch (catches both new + pre-existing from retries)
      const items = await prisma.enrichmentRunItem.findMany({
        where: { runId, contactId: { in: batch } },
        select: { id: true },
      });

      // Fan out enrich-contact jobs — BULK INSERT (single DB roundtrip)
      // vs sequential sendJob() which takes 20+ min for 60K items
      await insertJobs(
        items.map((item) => ({
          name: 'enrich-contact',
          data: { runItemId: item.id },
          options: {
            singletonKey: item.id,
            retryLimit: 3,
            retryDelay: 30,
            retryBackoff: true,
            expireInMinutes: 10,
          },
        }))
      );
      console.log(`[process-run] batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(contactIds.length / BATCH_SIZE)} fanned out (${items.length} items, ${Date.now() - batchStart}ms)`);
    }

    // ─── 7. Atomic finalization ───────────────────────────────────────────
    const finalRun = await prisma.enrichmentRun.findUnique({
      where: { id: runId },
      select: { status: true, completedItems: true, failedItems: true, skippedItems: true, totalItems: true },
    });
    if (!finalRun) return;

    if (finalRun.status === 'stopped') {
      // Stopped at boundary — just mark scope materialized
      await prisma.enrichmentRun.update({
        where: { id: runId },
        data: { scopeMaterialized: true },
      });
      return;
    }

    const accounted = finalRun.completedItems + finalRun.failedItems + finalRun.skippedItems;
    if (accounted >= finalRun.totalItems) {
      // All items already finished during fan-out
      await prisma.enrichmentRun.update({
        where: { id: runId },
        data: { scopeMaterialized: true, status: 'completed', completedAt: new Date() },
      });
    } else {
      await prisma.enrichmentRun.update({
        where: { id: runId },
        data: { scopeMaterialized: true, status: 'processing' },
      });
    }
    console.log(`[process-run] DONE run=${runId.slice(0, 8)} total=${contactIds.length} duration=${Math.round((Date.now() - startedAt) / 1000)}s`);
  } catch (err) {
    console.error(`process-run ${runId} failed:`, err);
    const errorMsg = err instanceof Error ? err.message : 'Fan-out error';

    // Write error but don't transition to failed (per §11 failed-state rule)
    await prisma.enrichmentRun.update({
      where: { id: runId },
      data: { errorMessage: `Run failed to start (${errorMsg}). Stop and retry, or contact support.` },
    });

    await prisma.runEvent.create({
      data: {
        runId,
        step: 'error',
        status: 'failed',
        message: errorMsg,
        metadata: { code: 'fanout_error' },
      },
    });

    throw err; // Let pg-boss retry
  }
}
