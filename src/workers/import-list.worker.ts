import { Readable } from 'node:stream';
import { Prisma } from '@prisma/client';
import { parse } from 'csv-parse';
import { prisma } from '../db.js';
import { supabaseAdmin } from '../services/supabase.js';
import { extractEmailDomain, extractWebsiteDomain } from '../utils/domain.js';

const BUCKET = 'csv-uploads';
const BATCH_SIZE = 5000;
const MAX_ROWS = 500_000;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface ColumnMapping {
  delimiter: string;
  encoding: string;
  mappings: Array<{
    csv_header: string;
    target: string;
    type: 'builtin' | 'custom';
    custom_field_id?: string;
  }>;
  skipped: string[];
  created_fields: string[];
}

interface ImportCounters {
  sourceRowCount: number;
  rejectedCount: number;
}

export async function handleImportList(job: { data: { listId: string } }) {
  const { listId } = job.data;

  const list = await prisma.contactList.findUnique({
    where: { id: listId },
    include: { user: { select: { id: true } } },
  });

  if (!list || list.status !== 'importing' || !list.columnMapping) {
    console.error(`import-list: invalid list state for ${listId}`);
    return;
  }

  const userId = list.userId;
  const mapping = list.columnMapping as unknown as ColumnMapping;

  try {
    // 1. Download CSV from Storage
    const storagePath = `${userId}/${listId}/original.csv`;
    const { data: fileData, error: dlError } = await supabaseAdmin.storage
      .from(BUCKET)
      .download(storagePath);

    if (dlError || !fileData) {
      throw new Error(`Failed to download CSV: ${dlError?.message}`);
    }

    const csvBuffer = Buffer.from(await fileData.arrayBuffer());

    // 2. Build header→index map from mapping
    const headerMap = buildHeaderMap(mapping, list.originalHeaders);

    // 3. Stream-parse and collect rows
    const { rows, counters, selectFieldValues } = await parseAndValidateRows(
      csvBuffer,
      mapping.delimiter,
      headerMap,
      MAX_ROWS
    );

    // 4. Batch upsert contacts
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      await upsertContactBatch(listId, batch);
    }

    // 5. Auto-append select options
    await autoAppendSelectOptions(userId, headerMap, selectFieldValues);

    // 6. Final counter calculation (deterministic on retry)
    const importedCount = await prisma.contact.count({ where: { listId } });
    const duplicateCount = counters.sourceRowCount - counters.rejectedCount - importedCount;

    // 7. Update list → ready
    await prisma.contactList.update({
      where: { id: listId },
      data: {
        status: 'ready',
        sourceRowCount: counters.sourceRowCount,
        importedCount,
        duplicateCount: Math.max(0, duplicateCount),
        rejectedCount: counters.rejectedCount,
      },
    });

    // 8. Delete CSV from Storage (successful import)
    await supabaseAdmin.storage.from(BUCKET).remove([storagePath]).catch(() => {});

    console.log(`import-list: ${listId} complete — ${importedCount} imported, ${counters.rejectedCount} rejected, ${duplicateCount} dupes`);
  } catch (err) {
    console.error(`import-list: ${listId} failed:`, err);
    await prisma.contactList.update({
      where: { id: listId },
      data: {
        status: 'import_failed',
        errorMessage: err instanceof Error ? err.message : 'Unknown import error',
      },
    });
  }
}

// ─── Parsing ─────────────────────────────────────────────────────────────────

interface HeaderMap {
  email: number;
  firstName: number | null;
  lastName: number | null;
  name: number | null;
  companyName: number | null;
  companyWebsite: number | null;
  customFields: Array<{
    csvIndex: number;
    fieldKey: string;
    fieldType: string;
    fieldId: string;
  }>;
}

function buildHeaderMap(mapping: ColumnMapping, originalHeaders: string[]): HeaderMap {
  const headerIndex = new Map<string, number>();
  originalHeaders.forEach((h, i) => headerIndex.set(h, i));

  const result: HeaderMap = {
    email: -1,
    firstName: null,
    lastName: null,
    name: null,
    companyName: null,
    companyWebsite: null,
    customFields: [],
  };

  for (const m of mapping.mappings) {
    const idx = headerIndex.get(m.csv_header);
    if (idx === undefined) continue;

    if (m.type === 'builtin') {
      switch (m.target) {
        case 'email': result.email = idx; break;
        case 'first_name': result.firstName = idx; break;
        case 'last_name': result.lastName = idx; break;
        case 'name': result.name = idx; break;
        case 'company_name': result.companyName = idx; break;
        case 'company_website': result.companyWebsite = idx; break;
      }
    } else if (m.type === 'custom' && m.custom_field_id) {
      result.customFields.push({
        csvIndex: idx,
        fieldKey: m.target,
        fieldType: 'text', // Will be resolved from DB
        fieldId: m.custom_field_id,
      });
    }
  }

  return result;
}

interface ParsedRow {
  email: string;
  firstName: string | null;
  lastName: string | null;
  name: string | null;
  companyName: string | null;
  companyWebsite: string | null;
  customFields: Record<string, unknown>;
  originalRow: Record<string, string>;
  rowIndex: number;
  websiteDomain: string | null;
  emailDomain: string | null;
  domainMismatch: boolean;
}

async function parseAndValidateRows(
  csvBuffer: Buffer,
  delimiter: string,
  headerMap: HeaderMap,
  maxRows: number
): Promise<{
  rows: ParsedRow[];
  counters: ImportCounters;
  selectFieldValues: Map<string, Set<string>>;
}> {
  // Load custom field types from DB
  const fieldTypes = new Map<string, string>();
  if (headerMap.customFields.length > 0) {
    const fields = await prisma.customField.findMany({
      where: { id: { in: headerMap.customFields.map((f) => f.fieldId) } },
      select: { id: true, fieldType: true },
    });
    for (const f of fields) fieldTypes.set(f.id, f.fieldType);
    // Update headerMap with actual types
    for (const cf of headerMap.customFields) {
      cf.fieldType = fieldTypes.get(cf.fieldId) ?? 'text';
    }
  }

  return new Promise((resolve, reject) => {
    const rows: ParsedRow[] = [];
    const seenEmails = new Set<string>();
    const counters: ImportCounters = { sourceRowCount: 0, rejectedCount: 0 };
    const selectFieldValues = new Map<string, Set<string>>();
    let headers: string[] = [];

    const parser = parse({
      delimiter,
      relax_column_count: true,
      skip_empty_lines: true,
      trim: true,
    });

    let isFirstRow = true;

    parser.on('readable', () => {
      let record: string[];
      while ((record = parser.read()) !== null) {
        if (isFirstRow) {
          headers = record;
          isFirstRow = false;
          continue;
        }

        counters.sourceRowCount++;

        if (counters.sourceRowCount > maxRows) {
          parser.destroy(new Error(`CSV exceeds ${maxRows} row limit`));
          return;
        }

        // Build original_row
        const originalRow: Record<string, string> = {};
        headers.forEach((h, i) => { originalRow[h] = record[i] ?? ''; });

        // Extract email
        const rawEmail = (record[headerMap.email] ?? '').trim().toLowerCase();
        if (!rawEmail) { counters.rejectedCount++; continue; }
        if (!EMAIL_REGEX.test(rawEmail)) { counters.rejectedCount++; continue; }

        // Deduplicate
        if (seenEmails.has(rawEmail)) continue; // duplicate_count calculated at end
        seenEmails.add(rawEmail);

        // Extract fields
        const rawFirstName = headerMap.firstName !== null ? (record[headerMap.firstName] ?? '').trim() || null : null;
        const rawLastName = headerMap.lastName !== null ? (record[headerMap.lastName] ?? '').trim() || null : null;
        const rawName = headerMap.name !== null ? (record[headerMap.name] ?? '').trim() || null : null;
        const companyName = headerMap.companyName !== null ? (record[headerMap.companyName] ?? '').trim() || null : null;
        const companyWebsite = headerMap.companyWebsite !== null ? (record[headerMap.companyWebsite] ?? '').trim() || null : null;

        // Name mapping rules per §8.5
        let firstName: string | null = null;
        let lastName: string | null = null;
        let displayName: string | null = null;

        if (headerMap.firstName !== null || headerMap.lastName !== null) {
          firstName = rawFirstName;
          lastName = rawLastName;
          const parts = [firstName ?? '', lastName ?? ''].filter(Boolean);
          displayName = parts.length > 0 ? parts.join(' ').trim() : null;
        } else {
          displayName = rawName;
        }

        // Custom fields with coercion
        const customFieldsData: Record<string, unknown> = {};
        for (const cf of headerMap.customFields) {
          const rawVal = (record[cf.csvIndex] ?? '').trim();
          if (!rawVal) continue;

          const coerced = coerceValue(rawVal, cf.fieldType);
          if (coerced !== undefined) {
            customFieldsData[cf.fieldKey] = coerced;

            // Track select field values for auto-append
            if (cf.fieldType === 'select') {
              let valSet = selectFieldValues.get(cf.fieldId);
              if (!valSet) { valSet = new Set(); selectFieldValues.set(cf.fieldId, valSet); }
              valSet.add(rawVal);
            }
          }
        }

        // Domain extraction at import time
        const emailDomain = extractEmailDomain(rawEmail);
        const websiteDomain = companyWebsite ? extractWebsiteDomain(companyWebsite) : null;
        const domainMismatch = !!(emailDomain && websiteDomain && emailDomain !== websiteDomain);

        rows.push({
          email: rawEmail,
          firstName,
          lastName,
          name: displayName,
          companyName,
          companyWebsite,
          customFields: Object.keys(customFieldsData).length > 0 ? customFieldsData : {},
          originalRow,
          rowIndex: counters.sourceRowCount,
          websiteDomain,
          emailDomain,
          domainMismatch,
        });
      }
    });

    parser.on('error', reject);
    parser.on('end', () => resolve({ rows, counters, selectFieldValues }));

    // Feed buffer to parser
    const stream = Readable.from(csvBuffer);
    stream.pipe(parser);
  });
}

// ─── Coercion per §8.5 ──────────────────────────────────────────────────────

function coerceValue(value: string, fieldType: string): unknown | undefined {
  switch (fieldType) {
    case 'number': {
      const n = parseFloat(value);
      return isNaN(n) ? undefined : n;
    }
    case 'boolean': {
      const lower = value.toLowerCase();
      if (['true', 'yes', '1'].includes(lower)) return true;
      if (['false', 'no', '0'].includes(lower)) return false;
      return undefined;
    }
    case 'date': {
      const d = new Date(value);
      return isNaN(d.getTime()) ? undefined : d.toISOString();
    }
    case 'select':
      return value; // stored as-is
    case 'text':
    case 'url':
    default:
      return value;
  }
}

// ─── Batch Upsert ────────────────────────────────────────────────────────────

async function upsertContactBatch(listId: string, rows: ParsedRow[]) {
  // Use createMany with skipDuplicates for ON CONFLICT DO NOTHING
  await prisma.contact.createMany({
    data: rows.map((r) => ({
      listId,
      email: r.email,
      firstName: r.firstName,
      lastName: r.lastName,
      name: r.name,
      companyName: r.companyName,
      companyWebsite: r.companyWebsite,
      customFields: r.customFields as Prisma.InputJsonValue,
      originalRow: r.originalRow as Prisma.InputJsonValue,
      rowIndex: r.rowIndex,
      websiteDomain: r.websiteDomain,
      emailDomain: r.emailDomain,
      domainMismatch: r.domainMismatch,
    })),
    skipDuplicates: true,
  });
}

// ─── Select Options Auto-Append ──────────────────────────────────────────────

async function autoAppendSelectOptions(
  userId: string,
  _headerMap: HeaderMap,
  selectFieldValues: Map<string, Set<string>>
) {
  for (const [fieldId, values] of selectFieldValues) {
    const newValues = Array.from(values);
    // Concurrency-safe append per §8.5
    await prisma.$executeRawUnsafe(
      `UPDATE custom_fields SET select_options = (
        SELECT array_agg(DISTINCT v ORDER BY v)
        FROM unnest(coalesce(select_options, '{}'::text[]) || $1::text[]) AS v
      ) WHERE id = $2::uuid AND user_id = $3::uuid`,
      newValues,
      fieldId,
      userId
    );
  }
}
