import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAdmin } from '../middleware/auth.middleware.js';
import { encrypt } from '../utils/encryption.js';
import { invalidateSnapshots } from '../enrichment/domain-intelligence.service.js';

const createProxySchema = z.object({
  name: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  username: z.string().optional(),
  password: z.string().optional(),
  protocol: z.enum(['http', 'https', 'socks5']).default('http'),
  isActive: z.boolean().default(true),
  priority: z.number().int().default(0),
});

const updateProxySchema = z.object({
  name: z.string().min(1).optional(),
  host: z.string().min(1).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().nullable().optional(),
  password: z.string().nullable().optional(),
  protocol: z.enum(['http', 'https', 'socks5']).optional(),
  isActive: z.boolean().optional(),
  priority: z.number().int().optional(),
});

export async function adminRoutes(app: FastifyInstance) {
  // All admin routes require admin role
  app.addHook('preHandler', requireAdmin);

  // ─── Proxies ─────────────────────────────────────────────────────────────

  // GET /api/admin/proxies
  app.get('/admin/proxies', async () => {
    const proxies = await prisma.proxyEndpoint.findMany({
      orderBy: { priority: 'desc' },
    });
    return {
      data: proxies.map(serializeProxy),
    };
  });

  // POST /api/admin/proxies
  app.post('/admin/proxies', async (request, reply) => {
    const body = createProxySchema.parse(request.body);
    const proxy = await prisma.proxyEndpoint.create({
      data: {
        name: body.name,
        host: body.host,
        port: body.port,
        usernameEnc: body.username ? encrypt(body.username) : null,
        passwordEnc: body.password ? encrypt(body.password) : null,
        protocol: body.protocol,
        isActive: body.isActive,
        priority: body.priority,
      },
    });
    return reply.status(201).send(serializeProxy(proxy));
  });

  // PUT /api/admin/proxies/:id
  app.put<{ Params: { id: string } }>('/admin/proxies/:id', async (request, reply) => {
    const body = updateProxySchema.parse(request.body);
    const existing = await prisma.proxyEndpoint.findUnique({ where: { id: request.params.id } });
    if (!existing) return reply.status(404).send({ error: { code: 'not_found', message: 'Proxy not found' } });

    const updateData: Record<string, unknown> = {};
    if (body.name !== undefined) updateData.name = body.name;
    if (body.host !== undefined) updateData.host = body.host;
    if (body.port !== undefined) updateData.port = body.port;
    if (body.protocol !== undefined) updateData.protocol = body.protocol;
    if (body.isActive !== undefined) updateData.isActive = body.isActive;
    if (body.priority !== undefined) updateData.priority = body.priority;
    if (body.username !== undefined) updateData.usernameEnc = body.username ? encrypt(body.username) : null;
    if (body.password !== undefined) updateData.passwordEnc = body.password ? encrypt(body.password) : null;

    const proxy = await prisma.proxyEndpoint.update({
      where: { id: request.params.id },
      data: updateData,
    });
    return serializeProxy(proxy);
  });

  // DELETE /api/admin/proxies/:id
  app.delete<{ Params: { id: string } }>('/admin/proxies/:id', async (request, reply) => {
    const existing = await prisma.proxyEndpoint.findUnique({ where: { id: request.params.id } });
    if (!existing) return reply.status(404).send({ error: { code: 'not_found', message: 'Proxy not found' } });
    await prisma.proxyEndpoint.delete({ where: { id: request.params.id } });
    return { success: true };
  });

  // POST /api/admin/proxies/:id/test
  app.post<{ Params: { id: string } }>('/admin/proxies/:id/test', async (request, reply) => {
    const proxy = await prisma.proxyEndpoint.findUnique({ where: { id: request.params.id } });
    if (!proxy) return reply.status(404).send({ error: { code: 'not_found', message: 'Proxy not found' } });

    const start = Date.now();
    try {
      const response = await fetch('https://example.com', {
        signal: AbortSignal.timeout(10_000),
      });
      return {
        success: response.ok,
        httpStatus: response.status,
        responseMs: Date.now() - start,
      };
    } catch (err) {
      return {
        success: false,
        responseMs: Date.now() - start,
        error: err instanceof Error ? err.message : 'Unknown error',
      };
    }
  });

  // ─── Domains ─────────────────────────────────────────────────────────────

  // GET /api/admin/domains
  app.get('/admin/domains', async (request) => {
    const query = request.query as Record<string, string>;
    const page = Math.max(1, parseInt(query.page ?? '1', 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(query.pageSize ?? '50', 10) || 50));
    const search = query.q?.trim();

    const where: any = {};
    if (search) {
      where.domain = { contains: search, mode: 'insensitive' };
    }

    const [domains, totalItems] = await Promise.all([
      prisma.domain.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          _count: { select: { classifications: true } },
          snapshots: {
            where: { scrapeSuccess: true, invalidatedAt: null },
            orderBy: { scrapedAt: 'desc' },
            take: 1,
            select: { scrapedAt: true },
          },
        },
      }),
      prisma.domain.count({ where }),
    ]);

    return {
      data: domains.map((d) => ({
        domain: d.domain,
        dnsValid: d.dnsValid,
        dnsCheckedAt: d.dnsCheckedAt?.toISOString() ?? null,
        latestSnapshotAt: d.snapshots[0]?.scrapedAt?.toISOString() ?? null,
        classificationsCount: d._count.classifications,
        createdAt: d.createdAt.toISOString(),
      })),
      pagination: { page, pageSize, totalItems, totalPages: Math.ceil(totalItems / pageSize) },
    };
  });

  // GET /api/admin/domains/:domain
  app.get<{ Params: { domain: string } }>('/admin/domains/:domain', async (request, reply) => {
    const domain = await prisma.domain.findUnique({
      where: { domain: request.params.domain },
      include: {
        snapshots: { orderBy: { scrapedAt: 'desc' }, take: 20 },
        classifications: { orderBy: { createdAt: 'desc' }, take: 50 },
      },
    });
    if (!domain) return reply.status(404).send({ error: { code: 'not_found', message: 'Domain not found' } });

    return {
      domain: {
        id: domain.id,
        domain: domain.domain,
        dnsValid: domain.dnsValid,
        dnsCheckedAt: domain.dnsCheckedAt?.toISOString() ?? null,
        createdAt: domain.createdAt.toISOString(),
        updatedAt: domain.updatedAt.toISOString(),
      },
      snapshots: domain.snapshots.map((s) => ({
        id: s.id,
        pageTitle: s.pageTitle,
        metaDescription: s.metaDescription,
        pagesScraped: s.pagesScraped,
        httpStatus: s.httpStatus,
        scrapeSuccess: s.scrapeSuccess,
        scrapeError: s.scrapeError,
        contentLength: s.contentLength,
        proxyUsed: s.proxyUsed,
        scrapedAt: s.scrapedAt.toISOString(),
        invalidatedAt: s.invalidatedAt?.toISOString() ?? null,
        createdAt: s.createdAt.toISOString(),
      })),
      classifications: domain.classifications.map((c) => ({
        id: c.id,
        snapshotId: c.snapshotId,
        aiProvider: c.aiProvider,
        aiModel: c.aiModel,
        promptId: c.promptId,
        promptVersion: c.promptVersion,
        promptHash: c.promptHash,
        industry: c.industry,
        subIndustry: c.subIndustry,
        confidence: c.confidence,
        reasoning: c.reasoning,
        inputTokens: c.inputTokens,
        outputTokens: c.outputTokens,
        costUsd: c.costUsd.toString(),
        createdAt: c.createdAt.toISOString(),
      })),
    };
  });

  // POST /api/admin/domains/:domain/invalidate
  app.post<{ Params: { domain: string } }>('/admin/domains/:domain/invalidate', async (request, reply) => {
    const count = await invalidateSnapshots(request.params.domain);
    if (count === null) return reply.status(404).send({ error: { code: 'not_found', message: 'Domain not found' } });
    return { invalidated: count };
  });

  // ─── Stats ───────────────────────────────────────────────────────────────

  // GET /api/admin/stats
  app.get('/admin/stats', async () => {
    const [
      usersTotal, adminsCount,
      listsTotal, listsActive, listsSoftDeleted,
      runsTotal, runsByStatus, allTimeCost, monthCost,
      domainsTotal, domainsWithSnapshot, classificationsTotal,
      proxiesTotal, proxiesActive,
      workers,
    ] = await Promise.all([
      prisma.profile.count(),
      prisma.profile.count({ where: { role: 'ADMIN' } }),
      prisma.contactList.count(),
      prisma.contactList.count({ where: { deletedAt: null } }),
      prisma.contactList.count({ where: { deletedAt: { not: null } } }),
      prisma.enrichmentRun.count(),
      prisma.enrichmentRun.groupBy({ by: ['status'], _count: true }),
      prisma.enrichmentRun.aggregate({ _sum: { totalCostUsd: true } }),
      prisma.enrichmentRun.aggregate({
        where: { createdAt: { gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) } },
        _sum: { totalCostUsd: true },
      }),
      prisma.domain.count(),
      prisma.$queryRawUnsafe<[{ count: bigint }]>(
        `SELECT COUNT(DISTINCT domain_id)::bigint as count FROM domain_snapshots WHERE scrape_success = true AND invalidated_at IS NULL`
      ),
      prisma.domainClassification.count(),
      prisma.proxyEndpoint.count(),
      prisma.proxyEndpoint.count({ where: { isActive: true } }),
      prisma.workerHeartbeat.findMany(),
    ]);

    const byStatus: Record<string, number> = {};
    for (const r of runsByStatus) byStatus[r.status] = r._count;

    return {
      users: { total: usersTotal, admins: adminsCount },
      lists: { total: listsTotal, active: listsActive, softDeleted: listsSoftDeleted },
      runs: {
        total: runsTotal,
        byStatus,
        totalCostUsdAllTime: (allTimeCost._sum.totalCostUsd ?? 0).toString(),
        totalCostUsdThisMonth: (monthCost._sum.totalCostUsd ?? 0).toString(),
      },
      domains: {
        total: domainsTotal,
        withActiveSnapshot: Number(domainsWithSnapshot[0]?.count ?? 0),
        classificationsTotal,
      },
      proxies: { total: proxiesTotal, active: proxiesActive, avgSuccessRatePhase1: 0 },
      workers: workers.map((w) => {
        const ageMs = Date.now() - w.lastHeartbeat.getTime();
        return {
          instanceId: w.instanceId,
          status: ageMs < 60000 ? 'healthy' as const : ageMs < 120000 ? 'degraded' as const : 'dead' as const,
          lastHeartbeat: w.lastHeartbeat.toISOString(),
          queues: w.queues,
        };
      }),
    };
  });
}

function serializeProxy(proxy: {
  id: string; name: string; host: string; port: number; protocol: string;
  isActive: boolean; priority: number; totalRequests: number; successCount: number;
  failureCount: number; avgResponseMs: number; lastUsedAt: Date | null;
  lastError: string | null; createdAt: Date; updatedAt: Date;
}) {
  return {
    id: proxy.id, name: proxy.name, host: proxy.host, port: proxy.port,
    protocol: proxy.protocol, isActive: proxy.isActive, priority: proxy.priority,
    totalRequests: proxy.totalRequests, successCount: proxy.successCount,
    failureCount: proxy.failureCount, avgResponseMs: proxy.avgResponseMs,
    lastUsedAt: proxy.lastUsedAt?.toISOString() ?? null,
    lastError: proxy.lastError, createdAt: proxy.createdAt.toISOString(),
    updatedAt: proxy.updatedAt.toISOString(),
  };
}
