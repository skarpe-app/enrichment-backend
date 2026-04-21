import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  getSettings,
  updateProfile,
  createAiCredential,
  updateAiCredential,
  deleteAiCredential,
  SettingsError,
} from '../services/settings.service.js';
import { getModelList } from '../enrichment/ai/cost.js';

const updateProfileSchema = z.object({
  name: z.string().nullable().optional(),
  domainCacheTtlDays: z.number().int().min(1).max(365).optional(),
});

export async function settingsRoutes(app: FastifyInstance) {
  // GET /api/settings
  app.get('/settings', async (request, reply) => {
    const settings = await getSettings(request.user.id);
    if (!settings) {
      return reply.status(500).send({
        error: { code: 'profile_missing', message: 'Profile not found' },
      });
    }
    return settings;
  });

  // PUT /api/settings
  app.put('/settings', async (request, reply) => {
    const body = updateProfileSchema.parse(request.body);
    try {
      const profile = await updateProfile(request.user.id, body);
      return {
        id: profile.id,
        email: profile.email,
        name: profile.name,
        role: profile.role,
        domainCacheTtlDays: profile.domainCacheTtlDays,
        createdAt: profile.createdAt.toISOString(),
        updatedAt: profile.updatedAt.toISOString(),
      };
    } catch (err) {
      if (err instanceof Error && err.message.includes('domainCacheTtlDays')) {
        return reply.status(400).send({
          error: { code: 'validation_error', message: err.message },
        });
      }
      throw err;
    }
  });

  // ─── AI Credentials ──────────────────────────────────────────────────────

  // POST /api/settings/ai-credentials
  app.post('/settings/ai-credentials', async (request, reply) => {
    const body = z.object({
      provider: z.enum(['openai']),
      label: z.string().min(1),
      apiKey: z.string().min(1),
      isDefault: z.boolean().optional(),
    }).parse(request.body);

    try {
      const credential = await createAiCredential(request.user.id, body);
      return reply.status(201).send(credential);
    } catch (err) {
      if (err instanceof SettingsError) {
        return reply.status(400).send({ error: { code: err.code, message: err.message } });
      }
      throw err;
    }
  });

  // PUT /api/settings/ai-credentials/:id
  app.put<{ Params: { id: string } }>('/settings/ai-credentials/:id', async (request, reply) => {
    const body = z.object({
      label: z.string().min(1).optional(),
      apiKey: z.string().min(1).optional(),
      isDefault: z.boolean().optional(),
    }).parse(request.body);

    try {
      const credential = await updateAiCredential(request.user.id, request.params.id, body);
      if (!credential) return reply.status(404).send({ error: { code: 'not_found', message: 'Credential not found' } });
      return credential;
    } catch (err) {
      if (err instanceof SettingsError) {
        return reply.status(409).send({ error: { code: err.code, message: err.message } });
      }
      throw err;
    }
  });

  // DELETE /api/settings/ai-credentials/:id
  app.delete<{ Params: { id: string } }>('/settings/ai-credentials/:id', async (request, reply) => {
    const result = await deleteAiCredential(request.user.id, request.params.id);
    if (result.status === 404) return reply.status(404).send({ error: { code: 'not_found', message: 'Credential not found' } });
    if (result.status === 409) return reply.status(409).send({ error: { code: result.code, message: result.message } });
    return { success: true };
  });

  // POST /api/settings/test-ai-key — test key validity per §6
  app.post('/settings/test-ai-key', async (request, reply) => {
    const body = z.object({ apiKey: z.string().min(1) }).parse(request.body);
    try {
      const OpenAI = (await import('openai')).default;
      const client = new OpenAI({ apiKey: body.apiKey });
      await client.models.list();
      return { valid: true };
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : 'Invalid key' };
    }
  });

  // GET /api/settings/models/:provider
  app.get<{ Params: { provider: string } }>('/settings/models/:provider', async (request, reply) => {
    if (request.params.provider !== 'openai') {
      return reply.status(400).send({ error: { code: 'invalid_provider', message: 'Only openai is supported in v1' } });
    }
    return { models: getModelList() };
  });
}
