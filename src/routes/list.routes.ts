import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  getUserLists,
  getListDetail,
  deleteList,
  createListFromUpload,
  confirmColumnMapping,
  ValidationError,
  RowLimitError,
} from '../services/list.service.js';
import { sendJob } from '../queue.js';
import { generateListExportCsv } from '../services/export.service.js';

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB

export async function listRoutes(app: FastifyInstance) {
  // POST /api/lists — multipart CSV upload (rate: 20/hr per user per §6)
  app.post('/lists', { config: { rateLimit: { max: 20, timeWindow: '1 hour', keyGenerator: (req: any) => req.user?.id ?? req.ip } } }, async (request, reply) => {
    const data = await request.file();
    if (!data) {
      return reply.status(400).send({
        error: { code: 'missing_file', message: 'No CSV file provided' },
      });
    }

    const buffer = await data.toBuffer();
    if (buffer.length > MAX_FILE_SIZE) {
      return reply.status(413).send({
        error: { code: 'file_too_large', message: 'File exceeds 100MB limit' },
      });
    }

    try {
      const result = await createListFromUpload(
        request.user.id,
        data.filename,
        buffer
      );
      return reply.status(201).send(result);
    } catch (err) {
      if (err instanceof RowLimitError) {
        return reply.status(413).send({
          error: { code: 'csv_row_limit_exceeded', message: 'CSV exceeds 500,000 row limit' },
        });
      }
      if (err instanceof Error && err.message.includes('Storage upload failed')) {
        return reply.status(500).send({
          error: { code: 'upload_failed', message: err.message },
        });
      }
      throw err;
    }
  });

  // GET /api/lists
  app.get('/lists', async (request) => {
    const query = request.query as { page?: string; pageSize?: string };
    const page = Math.max(1, parseInt(query.page ?? '1', 10) || 1);
    const pageSize = Math.min(500, Math.max(1, parseInt(query.pageSize ?? '50', 10) || 50));
    return getUserLists(request.user.id, page, pageSize);
  });

  // GET /api/lists/:id
  app.get<{ Params: { id: string } }>('/lists/:id', async (request, reply) => {
    const list = await getListDetail(request.user.id, request.params.id);
    if (!list) {
      return reply.status(404).send({ error: { code: 'not_found', message: 'List not found' } });
    }
    return list;
  });

  // DELETE /api/lists/:id
  app.delete<{ Params: { id: string } }>('/lists/:id', async (request, reply) => {
    const result = await deleteList(request.user.id, request.params.id);
    if (result.status === 404) {
      return reply.status(404).send({ error: { code: 'not_found', message: 'List not found' } });
    }
    if (result.status === 409) {
      return reply.status(409).send({ error: { code: result.code, message: result.message } });
    }
    return { success: true };
  });

  // POST /api/lists/:id/column-mapping
  app.post<{ Params: { id: string } }>('/lists/:id/column-mapping', async (request, reply) => {
    try {
      const result = await confirmColumnMapping(
        request.user.id,
        request.params.id,
        request.body as Record<string, unknown>
      );
      if (!result) {
        return reply.status(404).send({ error: { code: 'not_found', message: 'List not found or not in pending status' } });
      }

      // Queue import-list job
      await sendJob('import-list', { listId: result.listId }, {
        singletonKey: result.listId,
        retryLimit: 2,
        retryDelay: 30,
        retryBackoff: true,
        expireInMinutes: 30,
      });

      return result;
    } catch (err) {
      if (err instanceof ValidationError) {
        return reply.status(400).send({ error: { code: err.code, message: err.message } });
      }
      throw err;
    }
  });

  // GET /api/lists/:id/export — CSV export
  app.get<{ Params: { id: string } }>('/lists/:id/export', async (request, reply) => {
    const result = await generateListExportCsv(request.user.id, request.params.id);
    if (!result) return reply.status(404).send({ error: { code: 'not_found', message: 'List not found' } });
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${result.fileName}"`)
      .send(result.csv);
  });

  // GET /api/lists/:id/contacts — paginated contact list with filters
  app.get<{ Params: { id: string } }>('/lists/:id/contacts', async (request, reply) => {
    const { id: listId } = request.params;
    const query = request.query as Record<string, string>;

    // Verify list ownership
    const list = await import('../db.js').then((db) =>
      db.prisma.contactList.findFirst({
        where: { id: listId, userId: request.user.id, deletedAt: null },
        select: { id: true },
      })
    );
    if (!list) {
      return reply.status(404).send({ error: { code: 'not_found', message: 'List not found' } });
    }

    const page = Math.max(1, parseInt(query.page ?? '1', 10) || 1);
    const pageSize = Math.min(500, Math.max(1, parseInt(query.pageSize ?? '50', 10) || 50));
    const search = query.q?.trim() || undefined;

    const { prisma } = await import('../db.js');

    // Build where clause
    const where: any = { listId };

    if (search) {
      where.OR = [
        { email: { contains: search, mode: 'insensitive' } },
        { name: { contains: search, mode: 'insensitive' } },
        { companyName: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [contacts, totalItems] = await Promise.all([
      prisma.contact.findMany({
        where,
        orderBy: { rowIndex: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          latestResult: {
            select: { status: true, errorMessage: true, finishedAt: true },
          },
          latestSuccessfulResult: {
            select: {
              industry: true,
              subIndustry: true,
              confidence: true,
              reasoning: true,
              costUsd: true,
            },
          },
        },
      }),
      prisma.contact.count({ where }),
    ]);

    return {
      data: contacts.map((c) => ({
        id: c.id,
        email: c.email,
        firstName: c.firstName,
        lastName: c.lastName,
        name: c.name,
        companyName: c.companyName,
        companyWebsite: c.companyWebsite,
        websiteDomain: c.websiteDomain,
        emailDomain: c.emailDomain,
        domainMismatch: c.domainMismatch,
        customFields: (c.customFields as Record<string, unknown>) ?? {},
        rowIndex: c.rowIndex,
        latestStatus: c.latestResult?.status ?? null,
        latestErrorMessage: c.latestResult?.errorMessage ?? null,
        latestAttemptAt: c.latestResult?.finishedAt?.toISOString() ?? null,
        latestResultId: c.latestResultId,
        industry: c.latestSuccessfulResult?.industry ?? null,
        subIndustry: c.latestSuccessfulResult?.subIndustry ?? null,
        confidence: c.latestSuccessfulResult?.confidence ?? null,
        reasoning: c.latestSuccessfulResult?.reasoning ?? null,
        costUsd: c.latestSuccessfulResult?.costUsd?.toString() ?? null,
        latestSuccessfulResultId: c.latestSuccessfulResultId,
        createdAt: c.createdAt.toISOString(),
      })),
      pagination: {
        page,
        pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / pageSize),
      },
    };
  });
}
