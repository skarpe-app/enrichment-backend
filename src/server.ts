import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import { config } from './config.js';
import { prisma, disconnectAll } from './db.js';
import { authMiddleware } from './middleware/auth.middleware.js';
import { healthRoutes } from './routes/health.routes.js';
import { listRoutes } from './routes/list.routes.js';
import { customFieldRoutes } from './routes/custom-field.routes.js';
import { settingsRoutes } from './routes/settings.routes.js';
import { adminRoutes } from './routes/admin.routes.js';
import { runRoutes } from './routes/run.routes.js';
import { dashboardRoutes } from './routes/dashboard.routes.js';

const app = Fastify({
  logger: {
    level: config.NODE_ENV === 'production' ? 'info' : 'debug',
  },
  bodyLimit: 100 * 1024 * 1024, // 100MB per §8.1
});

// ─── CORS ────────────────────────────────────────────────────────────────────
// In dev: allow Vite dev server. In prod: allow configured frontend origin.
await app.register(cors, {
  origin: config.NODE_ENV === 'production'
    ? (config.FRONTEND_URL || true)
    : 'http://localhost:5173',
  credentials: true,
});

// ─── Rate limiting per §6 ────────────────────────────────────────────────────
await app.register(rateLimit, {
  max: 300,
  timeWindow: '1 minute',
  errorResponseBuilder: (_request: any, context: any) => ({
    error: {
      code: 'rate_limited',
      message: `Too many requests. Try again in ${Math.ceil(context.ttl / 1000)}s.`,
      details: { retryAfterSeconds: Math.ceil(context.ttl / 1000) },
    },
  }),
});

// ─── Auth middleware (global preHandler for /api/* except /api/health) ────────
app.addHook('preHandler', async (request, reply) => {
  const url = request.url;
  // Skip auth for health endpoint
  if (url === '/api/health' || url.startsWith('/api/health?')) {
    return;
  }
  // Only apply to API routes
  if (url.startsWith('/api/')) {
    await authMiddleware(request, reply);
  }
});

// ─── Multipart (for CSV uploads, 100MB limit) ───────────────────────────────
await app.register(multipart, {
  limits: { fileSize: 100 * 1024 * 1024 },
});

// ─── Routes ──────────────────────────────────────────────────────────────────
await app.register(healthRoutes, { prefix: '/api' });
await app.register(listRoutes, { prefix: '/api' });
await app.register(customFieldRoutes, { prefix: '/api' });
await app.register(settingsRoutes, { prefix: '/api' });
await app.register(adminRoutes, { prefix: '/api' });
await app.register(runRoutes, { prefix: '/api' });
await app.register(dashboardRoutes, { prefix: '/api' });

// ─── 404 handler ─────────────────────────────────────────────────────────────
// Frontend is deployed separately — backend only serves /api/* routes.
app.setNotFoundHandler(async (_request, reply) => {
  return reply.status(404).send({
    error: { code: 'not_found', message: 'API endpoint not found' },
  });
});

// ─── Graceful shutdown ───────────────────────────────────────────────────────
async function shutdown() {
  app.log.info('Shutting down...');
  await app.close();
  await disconnectAll();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ─── Start ───────────────────────────────────────────────────────────────────
try {
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  app.log.info(`Server running on port ${config.PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

export { app };
