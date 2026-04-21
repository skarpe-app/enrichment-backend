import { prisma } from '../db.js';
import type { FieldType } from '@prisma/client';

/**
 * Generate a field_key from a display name.
 * Converts to snake_case, ensures uniqueness by appending suffix if needed.
 */
async function generateFieldKey(userId: string, name: string): Promise<string> {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');

  if (!base) throw new Error('Invalid field name');

  // Check if key already exists for this user
  let key = base;
  let suffix = 1;
  while (true) {
    const existing = await prisma.customField.findUnique({
      where: { userId_fieldKey: { userId, fieldKey: key } },
    });
    if (!existing) return key;
    suffix++;
    key = `${base}_${suffix}`;
  }
}

export async function createCustomField(
  userId: string,
  data: { name: string; fieldType: FieldType; selectOptions?: string[] }
) {
  const fieldKey = await generateFieldKey(userId, data.name);

  // Determine next sort order
  const maxSort = await prisma.customField.aggregate({
    where: { userId },
    _max: { sortOrder: true },
  });
  const sortOrder = (maxSort._max.sortOrder ?? -1) + 1;

  // select_options: empty array for select type, empty array for others (Prisma handles the array)
  const selectOptions =
    data.fieldType === 'select'
      ? data.selectOptions ?? []
      : [];

  return prisma.customField.create({
    data: {
      userId,
      name: data.name.trim(),
      fieldKey,
      fieldType: data.fieldType,
      selectOptions,
      sortOrder,
    },
  });
}

export async function updateCustomField(
  userId: string,
  fieldId: string,
  data: { name?: string; selectOptions?: string[] }
) {
  const field = await prisma.customField.findFirst({
    where: { id: fieldId, userId },
  });
  if (!field) return null;

  // selectOptions update only allowed for select type
  if (data.selectOptions !== undefined && field.fieldType !== 'select') {
    throw new ConflictError('select_options_not_allowed', 'Cannot set select options on a non-select field');
  }

  return prisma.customField.update({
    where: { id: fieldId },
    data: {
      ...(data.name !== undefined ? { name: data.name.trim() } : {}),
      ...(data.selectOptions !== undefined ? { selectOptions: data.selectOptions } : {}),
    },
  });
}

export async function reorderCustomFields(
  userId: string,
  fieldIds: string[]
) {
  // Verify all field IDs belong to this user
  const existing = await prisma.customField.findMany({
    where: { userId },
    select: { id: true },
  });
  const existingIds = new Set(existing.map((f) => f.id));

  if (fieldIds.length !== existingIds.size) {
    throw new ValidationError('field_count_mismatch', 'Field IDs count does not match existing fields');
  }
  for (const id of fieldIds) {
    if (!existingIds.has(id)) {
      throw new ValidationError('unknown_field_id', `Field ID ${id} not found`);
    }
  }

  // Update sort orders in a transaction
  await prisma.$transaction(
    fieldIds.map((id, index) =>
      prisma.customField.update({
        where: { id },
        data: { sortOrder: index },
      })
    )
  );

  return fieldIds.map((id, index) => ({ id, sortOrder: index }));
}

export async function deleteCustomField(userId: string, fieldId: string) {
  const field = await prisma.customField.findFirst({
    where: { id: fieldId, userId },
  });
  if (!field) return null;

  // Hard delete the field row
  await prisma.customField.delete({ where: { id: fieldId } });

  // Queue background job to strip JSONB key from all contacts
  // Import boss lazily to avoid circular deps in Phase 1
  // The job will be handled by custom-field-cleanup worker
  return { fieldKey: field.fieldKey, userId };
}

export async function getCustomFields(userId: string) {
  return prisma.customField.findMany({
    where: { userId },
    orderBy: { sortOrder: 'asc' },
  });
}

// ─── Error classes ───────────────────────────────────────────────────────────

export class ConflictError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

export class ValidationError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}
