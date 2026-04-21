import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createCustomField,
  updateCustomField,
  reorderCustomFields,
  deleteCustomField,
  getCustomFields,
  ConflictError,
  ValidationError,
} from '../services/custom-field.service.js';
import { sendJob } from '../queue.js';

const FieldTypeEnum = z.enum(['text', 'number', 'date', 'boolean', 'url', 'select']);

const createSchema = z.object({
  name: z.string().min(1).max(100),
  fieldType: FieldTypeEnum,
  selectOptions: z.array(z.string()).optional(),
});

const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  selectOptions: z.array(z.string()).optional(),
});

const reorderSchema = z.object({
  fieldIds: z.array(z.string().uuid()).min(1),
});

export async function customFieldRoutes(app: FastifyInstance) {
  // GET /api/custom-fields
  app.get('/custom-fields', async (request) => {
    const fields = await getCustomFields(request.user.id);
    return fields.map(serializeField);
  });

  // POST /api/custom-fields
  app.post('/custom-fields', async (request, reply) => {
    const body = createSchema.parse(request.body);
    const field = await createCustomField(request.user.id, body);
    return reply.status(201).send(serializeField(field));
  });

  // PUT /api/custom-fields/reorder (must be before /:id to avoid route conflict)
  app.put('/custom-fields/reorder', async (request) => {
    const body = reorderSchema.parse(request.body);
    const result = await reorderCustomFields(request.user.id, body.fieldIds);
    return { fields: result };
  });

  // PUT /api/custom-fields/:id
  app.put<{ Params: { id: string } }>('/custom-fields/:id', async (request, reply) => {
    const body = updateSchema.parse(request.body);
    try {
      const field = await updateCustomField(request.user.id, request.params.id, body);
      if (!field) return reply.status(404).send({ error: { code: 'not_found', message: 'Custom field not found' } });
      return serializeField(field);
    } catch (err) {
      if (err instanceof ConflictError) {
        return reply.status(409).send({ error: { code: err.code, message: err.message } });
      }
      throw err;
    }
  });

  // DELETE /api/custom-fields/:id
  app.delete<{ Params: { id: string } }>('/custom-fields/:id', async (request, reply) => {
    const result = await deleteCustomField(request.user.id, request.params.id);
    if (!result) return reply.status(404).send({ error: { code: 'not_found', message: 'Custom field not found' } });

    // Queue background JSONB cleanup job
    await sendJob('custom-field-cleanup', {
      userId: result.userId,
      fieldKey: result.fieldKey,
    }, {
      retryLimit: 2,
      retryDelay: 10,
      retryBackoff: true,
      expireInMinutes: 10,
    });

    return { success: true };
  });

  // Zod error handler for this plugin scope
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.status(400).send({
        error: { code: 'validation_error', message: 'Invalid request', details: error.flatten().fieldErrors },
      });
    }
    if (error instanceof ValidationError) {
      return reply.status(400).send({ error: { code: error.code, message: error.message } });
    }
    throw error;
  });
}

function serializeField(field: {
  id: string;
  name: string;
  fieldKey: string;
  fieldType: string;
  selectOptions: string[];
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: field.id,
    name: field.name,
    fieldKey: field.fieldKey,
    fieldType: field.fieldType,
    selectOptions: field.selectOptions.length > 0 ? field.selectOptions : null,
    sortOrder: field.sortOrder,
    createdAt: field.createdAt.toISOString(),
    updatedAt: field.updatedAt.toISOString(),
  };
}
