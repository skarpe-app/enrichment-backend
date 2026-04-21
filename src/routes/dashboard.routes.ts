import type { FastifyInstance } from 'fastify';
import { getDashboard } from '../services/dashboard.service.js';

export async function dashboardRoutes(app: FastifyInstance) {
  app.get('/dashboard', async (request) => {
    return getDashboard(request.user.id);
  });
}
