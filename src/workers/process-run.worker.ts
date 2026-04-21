import { prisma } from '../db.js';
import { sendJob } from '../queue.js';

const BATCH_SIZE = 5000;

/**
 * Process-run worker per §11.
 * Resolves scope → materializes RunItems → fans out enrich-contact jobs.
 */
export async function handleProcessRun(job: { data: { runId: string } }) {
  const { runId } = job.data;

  const run = await prisma.enrichmentRun.findUnique({ where: { id: runId } });
  if (!run) return;
  if (run.status === 'stopped') return;

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
    for (let i = 0; i < contactIds.length; i += BATCH_SIZE) {
      // Check if stopped mid-fan-out
      const currentRun = await prisma.enrichmentRun.findUnique({
        where: { id: runId },
        select: { status: true },
      });
      if (currentRun?.status === 'stopped') return; // Leave scope_materialized = false

      const batch = contactIds.slice(i, i + BATCH_SIZE);

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

      // Fan out enrich-contact jobs
      for (const item of items) {
        await sendJob('enrich-contact', { runItemId: item.id }, {
          singletonKey: item.id,
          retryLimit: 3,
          retryDelay: 30,
          retryBackoff: true,
          expireInMinutes: 10,
        });
      }
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
