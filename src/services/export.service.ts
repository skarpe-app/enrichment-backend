import { prisma } from '../db.js';

const BOM = '\uFEFF';

/**
 * Generate CSV for list export per §6 (latest successful result per contact).
 * Returns a string — streaming deferred to v1 polish since Fastify handles backpressure.
 */
export async function generateListExportCsv(userId: string, listId: string): Promise<{ csv: string; fileName: string } | null> {
  const list = await prisma.contactList.findFirst({
    where: { id: listId, userId, deletedAt: null },
  });
  if (!list) return null;

  // Get custom fields for column headers
  const customFields = await prisma.customField.findMany({
    where: { userId },
    orderBy: { sortOrder: 'asc' },
  });

  // Get contacts with latest successful result
  const contacts = await prisma.contact.findMany({
    where: { listId },
    orderBy: { rowIndex: 'asc' },
    include: {
      latestSuccessfulResult: {
        select: { industry: true, subIndustry: true, confidence: true, reasoning: true },
      },
    },
  });

  // Build headers
  const headers = [
    'row_index', 'email', 'first_name', 'last_name', 'name',
    'company_name', 'company_website',
    'industry', 'sub_industry', 'confidence', 'reasoning',
    ...customFields.map((f) => f.name),
  ];

  // Add unmapped original headers
  const mappedHeaders = new Set(['row_index', 'email', 'first_name', 'last_name', 'name', 'company_name', 'company_website']);
  const originalHeaders = (list.originalHeaders ?? []).filter((h) => !mappedHeaders.has(h.toLowerCase().replace(/\s+/g, '_')));

  const allHeaders = [...headers, ...originalHeaders];

  // Build rows
  const rows = contacts.map((c) => {
    const result = c.latestSuccessfulResult;
    const customData = (c.customFields as Record<string, unknown>) ?? {};
    const originalRow = (c.originalRow as Record<string, string>) ?? {};

    return [
      String(c.rowIndex),
      c.email,
      c.firstName ?? '',
      c.lastName ?? '',
      c.name ?? '',
      c.companyName ?? '',
      c.companyWebsite ?? '',
      result?.industry ?? '',
      result?.subIndustry ?? '',
      result?.confidence != null ? String(result.confidence) : '',
      result?.reasoning ?? '',
      ...customFields.map((f) => renderCustomFieldValue(customData[f.fieldKey], f.fieldType)),
      ...originalHeaders.map((h) => originalRow[h] ?? ''),
    ];
  });

  const csv = BOM + formatCsv(allHeaders, rows);
  const date = new Date().toISOString().split('T')[0];
  const fileName = `${sanitizeFileName(list.name)}_list_${date}.csv`;

  return { csv, fileName };
}

/**
 * Generate CSV for run export per §6 (specific run's items).
 */
export async function generateRunExportCsv(userId: string, runId: string): Promise<{ csv: string; fileName: string } | null> {
  const run = await prisma.enrichmentRun.findFirst({
    where: { id: runId, userId },
    include: { list: { select: { name: true, deletedAt: true, originalHeaders: true } } },
  });
  if (!run || run.list.deletedAt) return null;

  const customFields = await prisma.customField.findMany({
    where: { userId },
    orderBy: { sortOrder: 'asc' },
  });

  const items = await prisma.enrichmentRunItem.findMany({
    where: { runId },
    include: {
      contact: {
        select: {
          rowIndex: true, email: true, firstName: true, lastName: true,
          name: true, companyName: true, companyWebsite: true,
          customFields: true, originalRow: true,
        },
      },
    },
    orderBy: { contact: { rowIndex: 'asc' } },
  });

  const headers = [
    'row_index', 'email', 'first_name', 'last_name', 'name',
    'company_name', 'company_website',
    'industry', 'sub_industry', 'confidence', 'reasoning',
    'status', 'domain', 'domain_source', 'scrape_status',
    'error_message', 'skip_reason',
    'input_tokens', 'output_tokens', 'cost_usd', 'attempt_count',
    ...customFields.map((f) => f.name),
  ];

  const rows = items.map((item) => {
    const c = item.contact;
    const customData = (c.customFields as Record<string, unknown>) ?? {};

    return [
      String(c.rowIndex), c.email, c.firstName ?? '', c.lastName ?? '',
      c.name ?? '', c.companyName ?? '', c.companyWebsite ?? '',
      item.industry ?? '', item.subIndustry ?? '',
      item.confidence != null ? String(item.confidence) : '',
      item.reasoning ?? '',
      item.status, item.domain ?? '', item.domainSource ?? '',
      item.scrapeStatus ?? '', item.errorMessage ?? '', item.skipReason ?? '',
      String(item.inputTokens ?? 0), String(item.outputTokens ?? 0),
      (item.costUsd ?? 0).toString(), String(item.attemptCount),
      ...customFields.map((f) => renderCustomFieldValue(customData[f.fieldKey], f.fieldType)),
    ];
  });

  const csv = BOM + formatCsv(headers, rows);
  const date = new Date().toISOString().split('T')[0];
  const fileName = `${sanitizeFileName(run.list.name)}_run_${date}.csv`;

  return { csv, fileName };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatCsv(headers: string[], rows: string[][]): string {
  const lines = [headers.map(escapeField).join(',')];
  for (const row of rows) {
    lines.push(row.map(escapeField).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

function escapeField(value: string): string {
  if (!value) return '';
  // Quote if contains comma, quote, newline, or non-ASCII
  if (/[,"\r\n]/.test(value) || /[^\x00-\x7F]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function renderCustomFieldValue(value: unknown, fieldType: string): string {
  if (value === null || value === undefined) return '';
  if (fieldType === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50);
}
