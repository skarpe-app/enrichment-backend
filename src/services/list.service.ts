import { prisma } from '../db.js';
import { supabaseAdmin } from './supabase.js';

const BUCKET = 'csv-uploads';

export async function getUserLists(
  userId: string,
  page: number,
  pageSize: number
) {
  const where = { userId, deletedAt: null };
  const [data, totalItems] = await Promise.all([
    prisma.contactList.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.contactList.count({ where }),
  ]);

  // Enrichment completion count per list (contacts with latest_successful_result_id set)
  const listIds = data.map((l) => l.id);
  const enrichedCounts = listIds.length > 0
    ? await prisma.contact.groupBy({
        by: ['listId'],
        where: { listId: { in: listIds }, latestSuccessfulResultId: { not: null } },
        _count: { _all: true },
      })
    : [];
  const enrichedMap = new Map(enrichedCounts.map((r) => [r.listId, r._count._all]));

  return {
    data: data.map((list) => ({
      ...serializeListSummary(list),
      enrichedCount: enrichedMap.get(list.id) ?? 0,
    })),
    pagination: {
      page,
      pageSize,
      totalItems,
      totalPages: Math.ceil(totalItems / pageSize),
    },
  };
}

export async function getListDetail(userId: string, listId: string) {
  const list = await prisma.contactList.findFirst({
    where: { id: listId, userId, deletedAt: null },
  });
  if (!list) return null;
  return serializeListDetail(list);
}

export async function deleteList(userId: string, listId: string) {
  const list = await prisma.contactList.findFirst({
    where: { id: listId, userId, deletedAt: null },
  });
  if (!list) return { status: 404 as const };

  // 409 if importing
  if (list.status === 'importing') {
    return { status: 409 as const, code: 'list_importing', message: 'Wait for import to finish' };
  }

  // 409 if active run
  const activeRun = await prisma.enrichmentRun.findFirst({
    where: { listId, status: { in: ['queuing', 'processing'] } },
  });
  if (activeRun) {
    return { status: 409 as const, code: 'active_run', message: 'Stop the active run first' };
  }

  // Delete Storage CSV if present
  await deleteStorageCsv(userId, listId);

  if (list.status === 'pending' || list.status === 'import_failed') {
    // Hard delete — no contacts, no runs, no billing to preserve
    await prisma.contactList.delete({ where: { id: listId } });
  } else {
    // Soft delete for ready lists — preserves enrichment_runs for billing audit
    await prisma.contactList.update({
      where: { id: listId },
      data: { deletedAt: new Date() },
    });
  }

  return { status: 200 as const };
}

export async function createListFromUpload(
  userId: string,
  fileName: string,
  fileBuffer: Buffer
) {
  // 1. Create list row (pending)
  const list = await prisma.contactList.create({
    data: {
      userId,
      name: fileName.replace(/\.[^.]+$/, ''), // Strip extension for display name
      fileName,
      status: 'pending',
    },
  });

  try {
    // 2. Upload to Supabase Storage
    const storagePath = `${userId}/${list.id}/original.csv`;
    const { error: uploadError } = await supabaseAdmin.storage
      .from(BUCKET)
      .upload(storagePath, fileBuffer, {
        contentType: 'text/csv',
        upsert: true,
      });

    if (uploadError) {
      // Cleanup: delete the list row
      await prisma.contactList.delete({ where: { id: list.id } });
      throw new Error(`Storage upload failed: ${uploadError.message}`);
    }

    // 3. Parse first rows for headers + preview + row count check per §8.1
    const csvText = fileBuffer.toString('utf-8');
    const { headers, preview, delimiter, rowCount } = parsePreview(csvText);

    // 500K row limit — enforced at upload time per §8.1
    if (rowCount > 500_000) {
      await prisma.contactList.delete({ where: { id: list.id } }).catch(() => {});
      await deleteStorageCsv(userId, list.id);
      throw new RowLimitError();
    }

    // 4. Update list with headers
    await prisma.contactList.update({
      where: { id: list.id },
      data: { originalHeaders: headers },
    });

    return {
      listId: list.id,
      headers,
      delimiter,
      encoding: 'utf-8',
      preview,
    };
  } catch (err) {
    // Cleanup on any failure
    await prisma.contactList.delete({ where: { id: list.id } }).catch(() => {});
    await deleteStorageCsv(userId, list.id);
    throw err;
  }
}

export async function confirmColumnMapping(
  userId: string,
  listId: string,
  mapping: Record<string, unknown>
) {
  const list = await prisma.contactList.findFirst({
    where: { id: listId, userId, deletedAt: null, status: 'pending' },
  });
  if (!list) return null;

  // Validate that mapping has email
  const mappings = (mapping as { mappings?: Array<{ target: string }> }).mappings ?? [];
  const hasEmail = mappings.some((m) => m.target === 'email');
  if (!hasEmail) {
    throw new ValidationError('missing_email_mapping', 'Email column mapping is required');
  }

  // Save mapping and transition to importing
  await prisma.contactList.update({
    where: { id: listId },
    data: {
      columnMapping: mapping as any,
      status: 'importing',
    },
  });

  return { listId, status: 'importing' };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function deleteStorageCsv(userId: string, listId: string) {
  const storagePath = `${userId}/${listId}/original.csv`;
  await supabaseAdmin.storage.from(BUCKET).remove([storagePath]).catch(() => {});
}

function parsePreview(csvText: string): {
  headers: string[];
  preview: string[][];
  delimiter: string;
  rowCount: number;
} {
  // Detect delimiter from first line
  const firstLine = csvText.split('\n')[0] ?? '';
  const delimiter = detectDelimiter(firstLine);

  const lines = csvText.split('\n').filter((l) => l.trim());
  const headers = parseCsvLine(lines[0] ?? '', delimiter);
  const preview = lines
    .slice(1, 4) // First 3 data rows
    .map((line) => parseCsvLine(line, delimiter));
  const rowCount = lines.length - 1; // Exclude header row

  return { headers, preview, delimiter, rowCount };
}

function detectDelimiter(line: string): string {
  const candidates = [',', ';', '\t', '|'];
  let best = ',';
  let bestCount = 0;
  for (const d of candidates) {
    const count = line.split(d).length - 1;
    if (count > bestCount) {
      bestCount = count;
      best = d;
    }
  }
  return best;
}

function parseCsvLine(line: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === delimiter && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

function serializeListSummary(list: {
  id: string;
  name: string;
  fileName: string;
  sourceRowCount: number;
  importedCount: number;
  duplicateCount: number;
  rejectedCount: number;
  status: string;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: list.id,
    name: list.name,
    fileName: list.fileName,
    sourceRowCount: list.sourceRowCount,
    importedCount: list.importedCount,
    duplicateCount: list.duplicateCount,
    rejectedCount: list.rejectedCount,
    status: list.status,
    errorMessage: list.errorMessage,
    createdAt: list.createdAt.toISOString(),
    updatedAt: list.updatedAt.toISOString(),
  };
}

function serializeListDetail(list: {
  id: string;
  name: string;
  fileName: string;
  sourceRowCount: number;
  importedCount: number;
  duplicateCount: number;
  rejectedCount: number;
  status: string;
  errorMessage: string | null;
  originalHeaders: string[];
  columnMapping: unknown;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    ...serializeListSummary(list),
    originalHeaders: list.originalHeaders.length > 0 ? list.originalHeaders : null,
    columnMapping: list.columnMapping ?? null,
  };
}

export class RowLimitError extends Error {
  constructor() {
    super('CSV exceeds 500,000 row limit');
    this.name = 'RowLimitError';
  }
}

export class ValidationError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}
