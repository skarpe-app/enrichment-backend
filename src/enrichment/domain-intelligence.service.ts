import { prisma } from '../db.js';
import type { CleanedSite } from './html-cleaner.js';

/**
 * Find or create a domain record.
 */
export async function findOrCreateDomain(domainName: string) {
  let domain = await prisma.domain.findUnique({ where: { domain: domainName } });
  if (!domain) {
    domain = await prisma.domain.create({
      data: { domain: domainName },
    });
  }
  return domain;
}

/**
 * Find the active snapshot for a domain per §5.10.
 * Active = latest row WHERE scrape_success = true AND invalidated_at IS NULL.
 */
export async function findActiveSnapshot(domainId: string) {
  return prisma.domainSnapshot.findFirst({
    where: {
      domainId,
      scrapeSuccess: true,
      invalidatedAt: null,
    },
    orderBy: { scrapedAt: 'desc' },
  });
}

/**
 * Check if a snapshot is fresh (within TTL and not force-rescraping).
 */
export function isSnapshotFresh(
  snapshot: { scrapedAt: Date } | null,
  ttlDays: number,
  forceRescrape: boolean
): boolean {
  if (!snapshot) return false;
  if (forceRescrape) return false;

  const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
  const age = Date.now() - snapshot.scrapedAt.getTime();
  return age < ttlMs;
}

/**
 * Create a new domain snapshot from scrape results.
 */
export async function createSnapshot(
  domainId: string,
  site: CleanedSite,
  httpStatus: number | null,
  proxyUsed: string | null
) {
  return prisma.domainSnapshot.create({
    data: {
      domainId,
      pageTitle: site.homepage.pageTitle,
      metaDescription: site.homepage.metaDescription,
      headings: site.homepage.headings,
      cleanedText: site.homepage.cleanedText,
      internalPages: site.internalPages.length > 0 ? site.internalPages : undefined,
      pagesScraped: site.pagesScraped,
      combinedDigest: site.combinedDigest,
      httpStatus,
      scrapeSuccess: true,
      contentLength: site.homepage.contentLength,
      proxyUsed,
      scrapedAt: new Date(),
    },
  });
}

/**
 * Create a failed snapshot for logging purposes.
 */
export async function createFailedSnapshot(
  domainId: string,
  error: string,
  httpStatus: number | null,
  proxyUsed: string | null
) {
  return prisma.domainSnapshot.create({
    data: {
      domainId,
      scrapeSuccess: false,
      scrapeError: error,
      httpStatus,
      proxyUsed,
      scrapedAt: new Date(),
    },
  });
}

/**
 * Find a cached classification per §5.11.
 * Matches on snapshot + provider + model + prompt combo.
 */
export async function findCachedClassification(params: {
  snapshotId: string;
  aiProvider: string;
  aiModel: string;
  promptId?: string | null;
  promptVersion?: string | null;
  promptHash?: string | null;
}) {
  if (params.promptId) {
    // Stored prompt mode
    return prisma.domainClassification.findFirst({
      where: {
        snapshotId: params.snapshotId,
        aiProvider: params.aiProvider as any,
        aiModel: params.aiModel,
        promptId: params.promptId,
        promptVersion: params.promptVersion ?? null,
      },
    });
  } else if (params.promptHash) {
    // Text prompt mode
    return prisma.domainClassification.findFirst({
      where: {
        snapshotId: params.snapshotId,
        aiProvider: params.aiProvider as any,
        aiModel: params.aiModel,
        promptHash: params.promptHash,
      },
    });
  }
  return null;
}

/**
 * Create or find an existing classification per §5.11.
 * Uses the partial unique indexes to deduplicate.
 */
export async function upsertClassification(params: {
  domainId: string;
  snapshotId: string;
  aiProvider: string;
  aiModel: string;
  promptId: string | null;
  promptVersion: string | null;
  promptHash: string | null;
  industry: string;
  subIndustry: string | null;
  confidence: number;
  reasoning: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  classifyMs: number | null;
}) {
  // Try to find existing first (the partial unique indexes handle dedup)
  const existing = await findCachedClassification({
    snapshotId: params.snapshotId,
    aiProvider: params.aiProvider,
    aiModel: params.aiModel,
    promptId: params.promptId,
    promptVersion: params.promptVersion,
    promptHash: params.promptHash,
  });

  if (existing) return existing;

  return prisma.domainClassification.create({
    data: {
      domainId: params.domainId,
      snapshotId: params.snapshotId,
      aiProvider: params.aiProvider as any,
      aiModel: params.aiModel,
      promptId: params.promptId,
      promptVersion: params.promptVersion,
      promptHash: params.promptHash,
      industry: params.industry,
      subIndustry: params.subIndustry,
      confidence: params.confidence,
      reasoning: params.reasoning,
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      costUsd: params.costUsd,
      classifyMs: params.classifyMs,
    },
  });
}

/**
 * Compute SHA-256 hash for text prompts per §7.
 */
export function computePromptHash(promptText: string): string {
  const { createHash } = require('node:crypto');
  return createHash('sha256').update(promptText.trim()).digest('hex').toLowerCase();
}

/**
 * Admin: invalidate all active snapshots for a domain per §5.10.
 */
export async function invalidateSnapshots(domainName: string) {
  const domain = await prisma.domain.findUnique({ where: { domain: domainName } });
  if (!domain) return null;

  const result = await prisma.domainSnapshot.updateMany({
    where: {
      domainId: domain.id,
      scrapeSuccess: true,
      invalidatedAt: null,
    },
    data: { invalidatedAt: new Date() },
  });

  return result.count;
}
