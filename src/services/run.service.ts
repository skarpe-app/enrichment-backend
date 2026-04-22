import { createHash } from 'node:crypto';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { sendJob, insertJobs } from '../queue.js';
import { isValidModel } from '../enrichment/ai/cost.js';

// ─── Create Run per §6 ──────────────────────────────────────────────────────

export async function createRun(userId: string, listId: string, body: any) {
  // Verify list ownership + not deleted
  const list = await prisma.contactList.findFirst({
    where: { id: listId, userId, deletedAt: null, status: 'ready' },
  });
  if (!list) throw new RunError('list_not_found', 'List not found or not ready', 404);

  // Concurrent run check
  const activeRun = await prisma.enrichmentRun.findFirst({
    where: { listId, status: { in: ['queuing', 'processing'] } },
  });
  if (activeRun) throw new RunError('list_already_has_active_run', 'List already has an active run', 409);

  // Validate model
  if (!isValidModel(body.aiModel)) throw new RunError('invalid_config', `Unknown model: ${body.aiModel}`, 400);

  // Resolve prompt config from promptSource
  let promptMode: 'prompt_id' | 'text';
  let promptId: string | null = null;
  let promptVersion: string | null = null;
  let promptText: string | null = null;
  let promptHash: string | null = null;

  if (body.promptSource === 'default') {
    promptMode = 'prompt_id';
    promptId = config.OPENAI_DEFAULT_PROMPT_ID;
    promptVersion = config.OPENAI_DEFAULT_PROMPT_VERSION;
  } else if (body.promptSource === 'stored') {
    if (!body.promptId) throw new RunError('invalid_config', 'promptId required for stored prompt', 400);
    promptMode = 'prompt_id';
    promptId = body.promptId;
    promptVersion = null;
  } else if (body.promptSource === 'text') {
    if (!body.promptText) throw new RunError('invalid_config', 'promptText required for text prompt', 400);
    promptMode = 'text';
    promptText = body.promptText;
    promptHash = createHash('sha256').update(body.promptText.trim()).digest('hex').toLowerCase();
  } else {
    throw new RunError('invalid_config', 'Invalid promptSource', 400);
  }

  // Validate stored prompt ID with a lightweight test call per §7
  if (promptMode === 'prompt_id' && promptId) {
    const apiKey = body.billingSource === 'user_credential' && body.aiCredentialId
      ? await (await import('./settings.service.js')).getDecryptedApiKey(body.aiCredentialId)
      : config.OPENAI_API_KEY;
    try {
      const OpenAI = (await import('openai')).default;
      const client = new OpenAI({ apiKey });
      await (client as any).responses.create({
        model: body.aiModel,
        input: '',
        prompt: {
          id: promptId,
          ...(promptVersion ? { version: promptVersion } : {}),
          variables: { html: '<html><body>test</body></html>' },
        },
      });
    } catch (err) {
      throw new RunError('prompt_resolution_failed', `Invalid prompt ID: ${err instanceof Error ? err.message : 'unknown error'}`, 400);
    }
  }

  // Validate credential ownership if user_credential
  if (body.billingSource === 'user_credential') {
    if (!body.aiCredentialId) throw new RunError('invalid_config', 'aiCredentialId required for user_credential billing', 400);
    const cred = await prisma.aiCredential.findFirst({
      where: { id: body.aiCredentialId, userId, provider: 'openai' },
    });
    if (!cred) throw new RunError('invalid_config', 'AI credential not found or not openai', 400);
  }

  // Scope validation
  if (body.scopeType === 'selected' && body.selectedContactIds) {
    if (body.selectedContactIds.length > 10000) throw new RunError('invalid_config', 'Max 10,000 selected contacts', 400);
    if (body.selectedContactIds.length === 0) throw new RunError('invalid_config', 'At least 1 contact required', 400);
  }

  const run = await prisma.enrichmentRun.create({
    data: {
      listId,
      userId,
      status: 'queuing',
      aiProvider: 'openai',
      aiModel: body.aiModel,
      promptMode,
      promptId,
      promptVersion,
      promptText,
      promptHash,
      billingSource: body.billingSource,
      aiCredentialId: body.billingSource === 'user_credential' ? body.aiCredentialId : null,
      domainResolutionMode: body.domainResolutionMode,
      combinedPriority: body.domainResolutionMode === 'combined' ? body.combinedPriority : null,
      forceRescrape: body.forceRescrape ?? false,
      domainCacheTtlDays: body.domainCacheTtlDays ?? 30,
      scopeType: body.scopeType ?? 'all',
      selectedContactIds: body.scopeType === 'selected' ? body.selectedContactIds : [],
      filterSnapshot: body.scopeType === 'filtered' ? body.filterSnapshot : undefined,
    },
  });

  // Queue process-run job
  await sendJob('process-run', { runId: run.id }, {
    singletonKey: run.id,
    retryLimit: 2,
    retryDelay: 15,
    retryBackoff: true,
    expireInMinutes: 30,
  });

  return run;
}

// ─── Stop per §11 ───────────────────────────────────────────────────────────

export async function stopRun(userId: string, runId: string) {
  const run = await prisma.enrichmentRun.findFirst({
    where: { id: runId, userId },
    include: { list: { select: { deletedAt: true } } },
  });
  if (!run || run.list.deletedAt) throw new RunError('not_found', 'Run not found', 404);
  if (!['queuing', 'processing'].includes(run.status)) throw new RunError('invalid_state', 'Run is not active', 409);

  await prisma.enrichmentRun.update({
    where: { id: runId },
    data: { status: 'stopped', stoppedAt: new Date() },
  });

  return { success: true };
}

// ─── Resume per §11 ─────────────────────────────────────────────────────────

export async function resumeRun(userId: string, runId: string) {
  const run = await prisma.enrichmentRun.findFirst({
    where: { id: runId, userId, status: 'stopped' },
    include: { list: { select: { id: true, deletedAt: true } } },
  });
  if (!run || run.list.deletedAt) throw new RunError('not_found', 'Run not found', 404);

  // Check single-active-run invariant
  const otherActive = await prisma.enrichmentRun.findFirst({
    where: { listId: run.listId, status: { in: ['queuing', 'processing'] }, id: { not: runId } },
  });
  if (otherActive) throw new RunError('list_already_has_active_run', 'Another run is active on this list', 409);

  // 1. Backfill contact pointers for items completed while stopped
  if (run.stoppedAt) {
    const completedWhileStopped = await prisma.enrichmentRunItem.findMany({
      where: {
        runId,
        status: { in: ['completed', 'failed', 'skipped'] },
        finishedAt: { gt: run.stoppedAt },
      },
      select: { id: true, contactId: true, status: true, finishedAt: true },
    });

    for (const item of completedWhileStopped) {
      await prisma.$executeRawUnsafe(
        `UPDATE contacts SET latest_result_id = $1::uuid WHERE id = $2::uuid AND (latest_result_id IS NULL OR (SELECT finished_at FROM enrichment_run_items WHERE id = contacts.latest_result_id) < $3)`,
        item.id, item.contactId, item.finishedAt
      );
      if (item.status === 'completed') {
        await prisma.$executeRawUnsafe(
          `UPDATE contacts SET latest_successful_result_id = $1::uuid WHERE id = $2::uuid AND (latest_successful_result_id IS NULL OR (SELECT finished_at FROM enrichment_run_items WHERE id = contacts.latest_successful_result_id) < $3)`,
          item.id, item.contactId, item.finishedAt
        );
      }
    }
  }

  // Clear stopped_at + error_message
  await prisma.enrichmentRun.update({
    where: { id: runId },
    data: { stoppedAt: null, errorMessage: null },
  });

  // 2. Stale-item sweep
  await prisma.$executeRawUnsafe(
    `UPDATE enrichment_run_items SET status = 'retrying', locked_at = NULL
     WHERE run_id = $1::uuid AND status IN ('scraping', 'classifying') AND locked_at < now() - interval '5 minutes'`,
    runId
  );

  // 3. Check immediate completion
  const current = await prisma.enrichmentRun.findUnique({
    where: { id: runId },
    select: { scopeMaterialized: true, completedItems: true, failedItems: true, skippedItems: true, totalItems: true },
  });

  if (current?.scopeMaterialized) {
    const accounted = (current.completedItems ?? 0) + (current.failedItems ?? 0) + (current.skippedItems ?? 0);
    if (accounted >= current.totalItems) {
      await prisma.enrichmentRun.update({
        where: { id: runId },
        data: { status: 'completed', completedAt: new Date() },
      });
      return { success: true, status: 'completed' };
    }

    // 5. Scope materialized → re-queue pending/retrying items
    await prisma.enrichmentRun.update({ where: { id: runId }, data: { status: 'processing' } });
    const pendingItems = await prisma.enrichmentRunItem.findMany({
      where: { runId, status: { in: ['pending', 'retrying'] } },
      select: { id: true },
    });
    await insertJobs(
      pendingItems.map((item) => ({
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
  } else {
    // 4. Scope not materialized → re-queue process-run
    await prisma.enrichmentRun.update({ where: { id: runId }, data: { status: 'queuing' } });
    await sendJob('process-run', { runId }, {
      singletonKey: runId,
      retryLimit: 2,
      retryDelay: 15,
      retryBackoff: true,
      expireInMinutes: 30,
    });
  }

  return { success: true, status: 'resumed' };
}

// ─── Retry per §11 ──────────────────────────────────────────────────────────

export async function retryItems(userId: string, runId: string, body: { itemIds?: string[]; filter?: { status: string } }) {
  const run = await prisma.enrichmentRun.findFirst({
    where: { id: runId, userId },
    include: { list: { select: { deletedAt: true } } },
  });
  if (!run || run.list.deletedAt) throw new RunError('not_found', 'Run not found', 404);

  // Parent run status rules
  if (run.status === 'stopped') throw new RunError('run_stopped', 'Resume the run first', 409);
  if (['queuing', 'failed'].includes(run.status)) throw new RunError('invalid_state', `Cannot retry items on a ${run.status} run`, 409);

  // If completed, check single-active-run before reopening
  if (run.status === 'completed') {
    const otherActive = await prisma.enrichmentRun.findFirst({
      where: { listId: run.listId, status: { in: ['queuing', 'processing'] }, id: { not: runId } },
    });
    if (otherActive) throw new RunError('list_already_has_active_run', 'Another run is active on this list', 409);
  }

  // Resolve item IDs
  let itemIds: string[];
  if (body.itemIds) {
    if (body.itemIds.length > 500) throw new RunError('invalid_config', 'Max 500 items per retry request', 400);
    itemIds = body.itemIds;
  } else if (body.filter?.status) {
    const items = await prisma.enrichmentRunItem.findMany({
      where: { runId, status: body.filter.status as any },
      select: { id: true },
    });
    itemIds = items.map((i) => i.id);
  } else {
    throw new RunError('invalid_config', 'Provide itemIds or filter', 400);
  }

  if (itemIds.length === 0) return { retriedCount: 0, skippedCount: 0 };

  // Process in batches of 500
  let totalRetried = 0;
  let totalSkipped = 0;
  let isFirstBatch = true;

  for (let i = 0; i < itemIds.length; i += 500) {
    const batch = itemIds.slice(i, i + 500);

    // CTE with FOR UPDATE per §11
    const result = await prisma.$queryRawUnsafe<Array<{ id: string; prev_status: string }>>(
      `WITH locked AS (
        SELECT id, status AS prev_status FROM enrichment_run_items
        WHERE run_id = $1::uuid AND id = ANY($2::uuid[]) AND status IN ('failed', 'skipped')
        FOR UPDATE
      ),
      updated AS (
        UPDATE enrichment_run_items i
        SET status = 'retrying', error_message = NULL, skip_reason = NULL, scrape_error = NULL, finished_at = NULL, locked_at = NULL
        FROM locked WHERE i.id = locked.id
        RETURNING i.id, locked.prev_status
      )
      SELECT id, prev_status FROM updated`,
      runId, batch
    );

    const failedCount = result.filter((r) => r.prev_status === 'failed').length;
    const skippedCount = result.filter((r) => r.prev_status === 'skipped').length;

    // Adjust run counters
    if (failedCount > 0 || skippedCount > 0) {
      await prisma.$executeRawUnsafe(
        `UPDATE enrichment_runs SET failed_items = failed_items - $2, skipped_items = skipped_items - $3 WHERE id = $1::uuid`,
        runId, failedCount, skippedCount
      );
    }

    // Reopen completed run on first batch
    if (isFirstBatch && run.status === 'completed' && result.length > 0) {
      await prisma.enrichmentRun.update({
        where: { id: runId },
        data: { status: 'processing', completedAt: null },
      });
      isFirstBatch = false;
    }

    // Enqueue jobs in bulk
    await insertJobs(
      result.map((item) => ({
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

    totalRetried += result.length;
    totalSkipped += batch.length - result.length;
  }

  return { retriedCount: totalRetried, skippedCount: totalSkipped };
}

// ─── Get run progress per §6 ────────────────────────────────────────────────

export async function getRunProgress(userId: string, runId: string, sinceId?: number) {
  const run = await prisma.enrichmentRun.findFirst({
    where: { id: runId, userId },
    include: { list: { select: { deletedAt: true } } },
  });
  if (!run || run.list.deletedAt) return null;

  // Events with sinceId cursor
  let events;
  if (sinceId) {
    events = await prisma.$queryRawUnsafe<any[]>(
      `SELECT * FROM (SELECT * FROM run_events WHERE run_id = $1::uuid AND id > $2 ORDER BY id DESC LIMIT 50) sub ORDER BY id ASC`,
      runId, sinceId
    );
  } else {
    events = await prisma.$queryRawUnsafe<any[]>(
      `SELECT * FROM (SELECT * FROM run_events WHERE run_id = $1::uuid ORDER BY id DESC LIMIT 50) sub ORDER BY id ASC`,
      runId
    );
  }

  const lastEventId = events.length > 0 ? Number(events[events.length - 1].id) : null;

  return {
    run: {
      id: run.id,
      status: run.status,
      totalItems: run.totalItems,
      completedItems: run.completedItems,
      failedItems: run.failedItems,
      skippedItems: run.skippedItems,
      totalInputTokens: run.totalInputTokens,
      totalOutputTokens: run.totalOutputTokens,
      totalCostUsd: run.totalCostUsd.toString(),
      startedAt: run.startedAt?.toISOString() ?? null,
      stoppedAt: run.stoppedAt?.toISOString() ?? null,
      completedAt: run.completedAt?.toISOString() ?? null,
      errorMessage: run.errorMessage,
      scopeMaterialized: run.scopeMaterialized,
    },
    events: events.map((e: any) => ({
      id: Number(e.id),
      runId: e.run_id,
      runItemId: e.run_item_id,
      contactId: e.contact_id,
      step: e.step,
      status: e.status,
      message: e.message,
      durationMs: e.duration_ms,
      metadata: e.metadata,
      createdAt: e.created_at instanceof Date ? e.created_at.toISOString() : e.created_at,
    })),
    lastEventId,
  };
}

export class RunError extends Error {
  constructor(public code: string, message: string, public status: number) {
    super(message);
    this.name = 'RunError';
  }
}
