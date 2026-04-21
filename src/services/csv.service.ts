/**
 * Auto-detect column mappings per §8.2.
 * Scans CSV headers for common patterns and maps to built-in + custom fields.
 */

const BUILTIN_PATTERNS: Record<string, RegExp[]> = {
  email: [/^e[-_]?mail$/i, /^email[-_]?address$/i],
  first_name: [/^first[-_]?name$/i, /^given[-_]?name$/i, /^firstname$/i],
  last_name: [/^last[-_]?name$/i, /^surname$/i, /^family[-_]?name$/i, /^lastname$/i],
  name: [/^name$/i, /^full[-_]?name$/i, /^contact[-_]?name$/i],
  company_name: [/^company$/i, /^company[-_]?name$/i, /^organization$/i, /^organisation$/i],
  company_website: [/^website$/i, /^company[-_]?website$/i, /^url$/i, /^domain$/i, /^web$/i],
};

export interface AutoMapping {
  csv_header: string;
  target: string | null;
  type: 'builtin' | 'custom' | null;
  custom_field_id?: string;
  status: 'mapped' | 'pending';
}

export function autoDetectMappings(
  headers: string[],
  customFields: Array<{ id: string; name: string; fieldKey: string }>
): AutoMapping[] {
  const usedTargets = new Set<string>();

  return headers.map((header) => {
    const trimmed = header.trim();

    // Try built-in patterns
    for (const [target, patterns] of Object.entries(BUILTIN_PATTERNS)) {
      if (usedTargets.has(target)) continue;
      if (patterns.some((p) => p.test(trimmed))) {
        usedTargets.add(target);
        return { csv_header: header, target, type: 'builtin' as const, status: 'mapped' as const };
      }
    }

    // Try custom field name match (case-insensitive)
    for (const cf of customFields) {
      const cfTarget = `custom:${cf.fieldKey}`;
      if (usedTargets.has(cfTarget)) continue;
      if (cf.name.toLowerCase() === trimmed.toLowerCase()) {
        usedTargets.add(cfTarget);
        return {
          csv_header: header,
          target: cf.fieldKey,
          type: 'custom' as const,
          custom_field_id: cf.id,
          status: 'mapped' as const,
        };
      }
    }

    return { csv_header: header, target: null, type: null, status: 'pending' as const };
  });
}
