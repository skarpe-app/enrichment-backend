import type { FastifyInstance } from 'fastify';
import { createRun, stopRun, resumeRun, retryItems, getRunProgress, RunError } from '../services/run.service.js';
import { prisma } from '../db.js';
import { generateRunExportCsv } from '../services/export.service.js';

export async function runRoutes(app: FastifyInstance) {
  // POST /api/lists/:id/runs — create run (rate: 30/min per user per §6)
  app.post<{ Params: { id: string } }>('/lists/:id/runs', { config: { rateLimit: { max: 30, timeWindow: '1 minute', keyGenerator: (req: any) => req.user?.id ?? req.ip } } }, async (request, reply) => {
    try {
      const run = await createRun(request.user.id, request.params.id, request.body);
      return reply.status(201).send({ run: serializeRun(run) });
    } catch (err) {
      if (err instanceof RunError) return reply.status(err.status).send({ error: { code: err.code, message: err.message } });
      throw err;
    }
  });

  // GET /api/lists/:id/runs — list runs for a list
  app.get<{ Params: { id: string } }>('/lists/:id/runs', async (request, reply) => {
    const list = await prisma.contactList.findFirst({
      where: { id: request.params.id, userId: request.user.id, deletedAt: null },
    });
    if (!list) return reply.status(404).send({ error: { code: 'not_found', message: 'List not found' } });

    const query = request.query as Record<string, string>;
    const page = Math.max(1, parseInt(query.page ?? '1', 10) || 1);
    const pageSize = Math.min(50, Math.max(1, parseInt(query.pageSize ?? '20', 10) || 20));

    const [runs, totalItems] = await Promise.all([
      prisma.enrichmentRun.findMany({
        where: { listId: request.params.id, userId: request.user.id },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.enrichmentRun.count({ where: { listId: request.params.id, userId: request.user.id } }),
    ]);

    return {
      data: runs.map(serializeRun),
      pagination: { page, pageSize, totalItems, totalPages: Math.ceil(totalItems / pageSize) },
    };
  });

  // GET /api/runs/:runId — run detail
  app.get<{ Params: { runId: string } }>('/runs/:runId', async (request, reply) => {
    const run = await prisma.enrichmentRun.findFirst({
      where: { id: request.params.runId, userId: request.user.id },
      include: { list: { select: { deletedAt: true } } },
    });
    if (!run || run.list.deletedAt) return reply.status(404).send({ error: { code: 'not_found', message: 'Run not found' } });
    return serializeRunDetail(run);
  });

  // POST /api/runs/:runId/stop
  app.post<{ Params: { runId: string } }>('/runs/:runId/stop', async (request, reply) => {
    try {
      return await stopRun(request.user.id, request.params.runId);
    } catch (err) {
      if (err instanceof RunError) return reply.status(err.status).send({ error: { code: err.code, message: err.message } });
      throw err;
    }
  });

  // POST /api/runs/:runId/resume
  app.post<{ Params: { runId: string } }>('/runs/:runId/resume', async (request, reply) => {
    try {
      return await resumeRun(request.user.id, request.params.runId);
    } catch (err) {
      if (err instanceof RunError) return reply.status(err.status).send({ error: { code: err.code, message: err.message } });
      throw err;
    }
  });

  // GET /api/runs/:runId/progress
  app.get<{ Params: { runId: string } }>('/runs/:runId/progress', async (request, reply) => {
    const query = request.query as Record<string, string>;
    const sinceId = query.sinceId ? parseInt(query.sinceId, 10) : undefined;
    const progress = await getRunProgress(request.user.id, request.params.runId, sinceId);
    if (!progress) return reply.status(404).send({ error: { code: 'not_found', message: 'Run not found' } });
    return progress;
  });

  // GET /api/runs/:runId/events — paginated full event audit log per §6
  app.get<{ Params: { runId: string } }>('/runs/:runId/events', async (request, reply) => {
    const run = await prisma.enrichmentRun.findFirst({
      where: { id: request.params.runId, userId: request.user.id },
      include: { list: { select: { deletedAt: true } } },
    });
    if (!run || run.list.deletedAt) return reply.status(404).send({ error: { code: 'not_found', message: 'Run not found' } });

    const query = request.query as Record<string, string>;
    const page = Math.max(1, parseInt(query.page ?? '1', 10) || 1);
    const pageSize = Math.min(500, Math.max(1, parseInt(query.pageSize ?? '50', 10) || 50));

    const [events, totalItems] = await Promise.all([
      prisma.runEvent.findMany({
        where: { runId: request.params.runId },
        orderBy: { id: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.runEvent.count({ where: { runId: request.params.runId } }),
    ]);

    return {
      data: events.reverse().map((e) => ({
        id: Number(e.id),
        runId: e.runId,
        runItemId: e.runItemId,
        contactId: e.contactId,
        step: e.step,
        status: e.status,
        message: e.message,
        durationMs: e.durationMs,
        metadata: e.metadata,
        createdAt: e.createdAt.toISOString(),
      })),
      pagination: { page, pageSize, totalItems, totalPages: Math.ceil(totalItems / pageSize) },
    };
  });

  // GET /api/runs/:runId/export — CSV export
  app.get<{ Params: { runId: string } }>('/runs/:runId/export', async (request, reply) => {
    const result = await generateRunExportCsv(request.user.id, request.params.runId);
    if (!result) return reply.status(404).send({ error: { code: 'not_found', message: 'Run not found' } });
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${result.fileName}"`)
      .send(result.csv);
  });

  // POST /api/runs/:runId/retry — bulk retry
  app.post<{ Params: { runId: string } }>('/runs/:runId/retry', async (request, reply) => {
    try {
      return await retryItems(request.user.id, request.params.runId, request.body as any);
    } catch (err) {
      if (err instanceof RunError) return reply.status(err.status).send({ error: { code: err.code, message: err.message } });
      throw err;
    }
  });

  // POST /api/run-items/:id/retry — single item retry
  app.post<{ Params: { id: string } }>('/run-items/:id/retry', async (request, reply) => {
    const item = await prisma.enrichmentRunItem.findUnique({
      where: { id: request.params.id },
      include: { run: { select: { id: true, userId: true } } },
    });
    if (!item || item.run.userId !== request.user.id) {
      return reply.status(404).send({ error: { code: 'not_found', message: 'Run item not found' } });
    }
    try {
      return await retryItems(request.user.id, item.run.id, { itemIds: [item.id] });
    } catch (err) {
      if (err instanceof RunError) return reply.status(err.status).send({ error: { code: err.code, message: err.message } });
      throw err;
    }
  });

  // GET /api/runs/:runId/items — paginated run items
  app.get<{ Params: { runId: string } }>('/runs/:runId/items', async (request, reply) => {
    const run = await prisma.enrichmentRun.findFirst({
      where: { id: request.params.runId, userId: request.user.id },
      include: { list: { select: { deletedAt: true } } },
    });
    if (!run || run.list.deletedAt) return reply.status(404).send({ error: { code: 'not_found', message: 'Run not found' } });

    const query = request.query as Record<string, string>;
    const page = Math.max(1, parseInt(query.page ?? '1', 10) || 1);
    const pageSize = Math.min(1000, Math.max(1, parseInt(query.pageSize ?? '50', 10) || 50));
    const statusFilter = query.status;

    const where: any = { runId: request.params.runId };
    if (statusFilter) where.status = statusFilter;

    const [items, totalItems] = await Promise.all([
      prisma.enrichmentRunItem.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { contact: { select: { email: true, rowIndex: true } } },
      }),
      prisma.enrichmentRunItem.count({ where }),
    ]);

    return {
      data: items.map((i) => ({
        id: i.id, runId: i.runId, contactId: i.contactId,
        contactEmail: i.contact.email, contactRowIndex: i.contact.rowIndex,
        status: i.status, domain: i.domain, domainSource: i.domainSource,
        fallbackDomain: i.fallbackDomain, fallbackAttempted: i.fallbackAttempted,
        scrapeStatus: i.scrapeStatus, scrapeError: i.scrapeError, scrapeMs: i.scrapeMs, proxyUsed: i.proxyUsed,
        industry: i.industry, subIndustry: i.subIndustry, confidence: i.confidence, reasoning: i.reasoning,
        inputTokens: i.inputTokens ?? 0, outputTokens: i.outputTokens ?? 0,
        costUsd: (i.costUsd ?? 0).toString(), classifyMs: i.classifyMs,
        skipReason: i.skipReason, errorMessage: i.errorMessage, attemptCount: i.attemptCount,
        lockedAt: i.lockedAt?.toISOString() ?? null, finishedAt: i.finishedAt?.toISOString() ?? null,
        createdAt: i.createdAt.toISOString(), updatedAt: i.updatedAt.toISOString(),
      })),
      pagination: { page, pageSize, totalItems, totalPages: Math.ceil(totalItems / pageSize) },
    };
  });
}

function serializeRun(run: any) {
  return {
    id: run.id, listId: run.listId, status: run.status,
    aiProvider: run.aiProvider, aiModel: run.aiModel,
    billingSource: run.billingSource, domainResolutionMode: run.domainResolutionMode,
    totalItems: run.totalItems, completedItems: run.completedItems,
    failedItems: run.failedItems, skippedItems: run.skippedItems,
    totalCostUsd: run.totalCostUsd.toString(), scopeMaterialized: run.scopeMaterialized,
    errorMessage: run.errorMessage,
    startedAt: run.startedAt?.toISOString() ?? null, completedAt: run.completedAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(),
  };
}

function serializeRunDetail(run: any) {
  return {
    ...serializeRun(run),
    combinedPriority: run.combinedPriority, forceRescrape: run.forceRescrape,
    domainCacheTtlDays: run.domainCacheTtlDays, scopeType: run.scopeType,
    selectedContactIds: run.selectedContactIds?.length > 0 ? run.selectedContactIds : null,
    filterSnapshot: run.filterSnapshot, promptId: run.promptId,
    promptVersion: run.promptVersion, promptHash: run.promptHash,
    aiCredentialId: run.aiCredentialId,
    totalInputTokens: run.totalInputTokens, totalOutputTokens: run.totalOutputTokens,
    stoppedAt: run.stoppedAt?.toISOString() ?? null, updatedAt: run.updatedAt.toISOString(),
  };
}
