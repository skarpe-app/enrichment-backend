import type { FastifyInstance } from 'fastify';
import { prisma } from '../db.js';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health', async (_request, reply) => {
    const startTime = process.uptime();

    // Check worker heartbeat
    let workerStatus: 'healthy' | 'degraded' | 'dead' = 'dead';
    let lastHeartbeat: string | null = null;
    let workerInstanceId: string | null = null;

    try {
      const heartbeat = await prisma.workerHeartbeat.findFirst({
        orderBy: { lastHeartbeat: 'desc' },
      });

      if (heartbeat) {
        workerInstanceId = heartbeat.instanceId;
        lastHeartbeat = heartbeat.lastHeartbeat.toISOString();

        const ageMs = Date.now() - heartbeat.lastHeartbeat.getTime();
        if (ageMs < 60_000) {
          workerStatus = 'healthy';
        } else if (ageMs < 120_000) {
          workerStatus = 'degraded';
        } else {
          workerStatus = 'dead';
        }
      }
    } catch {
      // DB unreachable — worker status stays 'dead'
    }

    // Queue depths (pg-boss tables may not exist yet on first deploy)
    const queues: Record<string, { queued: number; retrying: number }> = {
      'import-list': { queued: 0, retrying: 0 },
      'process-run': { queued: 0, retrying: 0 },
      'enrich-contact': { queued: 0, retrying: 0 },
    };

    try {
      const queueNames = Object.keys(queues);
      for (const queueName of queueNames) {
        const result = await prisma.$queryRawUnsafe<
          Array<{ state: string; count: bigint }>
        >(
          `SELECT state, COUNT(*)::bigint as count FROM pgboss.job WHERE name = $1 AND state IN ('created', 'retry') GROUP BY state`,
          queueName
        );
        for (const row of result) {
          if (row.state === 'created') {
            queues[queueName].queued = Number(row.count);
          } else if (row.state === 'retry') {
            queues[queueName].retrying = Number(row.count);
          }
        }
      }
    } catch {
      // pg-boss schema may not exist yet — leave queue depths at 0
    }

    const overallStatus = workerStatus === 'dead' ? 'degraded' : 'healthy';

    return reply.send({
      status: overallStatus,
      server: { uptime: Math.floor(startTime) },
      worker: {
        status: workerStatus,
        last_heartbeat: lastHeartbeat,
        instance_id: workerInstanceId,
      },
      queues,
    });
  });
}
