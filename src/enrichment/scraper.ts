import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { checkDns } from './dns-checker.js';
import { scrapeUrl, type ProxyAttemptLog, type ScrapeResult } from './proxy-racer.js';
import { cleanHtml, buildCombinedDigest, getInternalPagesToScrape, type CleanedSite } from './html-cleaner.js';
import {
  findOrCreateDomain,
  findActiveSnapshot,
  isSnapshotFresh,
  createSnapshot,
  createFailedSnapshot,
} from './domain-intelligence.service.js';

export interface ScrapeOutcome {
  success: boolean;
  snapshotId: string | null;
  combinedDigest: string | null;
  scrapeMs: number;
  proxyUsed: string | null;
  error: string | null;
  isCache: boolean;
  skipReason: 'non_html_content' | null;
  attempts: ProxyAttemptLog[];
}

/**
 * Full scrape pipeline for a single domain per §10 steps 3-4.
 * Returns a snapshot (fresh or cached) or a failure reason.
 */
export async function scrapeDomain(
  domainName: string,
  ttlDays: number,
  forceRescrape: boolean,
  runId: string | null
): Promise<ScrapeOutcome> {
  const startMs = Date.now();

  // Find/create domain record
  const domain = await findOrCreateDomain(domainName);

  // Check for active cached snapshot
  const activeSnapshot = await findActiveSnapshot(domain.id);
  if (isSnapshotFresh(activeSnapshot, ttlDays, forceRescrape) && activeSnapshot) {
    return {
      success: true,
      snapshotId: activeSnapshot.id,
      combinedDigest: activeSnapshot.combinedDigest,
      scrapeMs: Date.now() - startMs,
      proxyUsed: null,
      error: null,
      isCache: true,
      skipReason: null,
      attempts: [],
    };
  }

  // DNS pre-check
  const dnsResult = await checkDns(domainName);
  if (!dnsResult.valid) {
    return {
      success: false,
      snapshotId: null,
      combinedDigest: null,
      scrapeMs: Date.now() - startMs,
      proxyUsed: null,
      error: 'DNS resolution failed',
      isCache: false,
      skipReason: null,
      attempts: [],
    };
  }

  // Proxy racing
  const scrapeResult = await scrapeUrl(domainName, runId);

  // Log proxy attempt events
  await logProxyAttempts(scrapeResult.attempts, domainName, runId);

  const { outcome } = scrapeResult;

  // non_html → don't create snapshot, signal skip
  if (outcome.kind === 'non_html') {
    return {
      success: false,
      snapshotId: null,
      combinedDigest: null,
      scrapeMs: Date.now() - startMs,
      proxyUsed: outcome.proxyName,
      error: null,
      isCache: false,
      skipReason: 'non_html_content',
      attempts: scrapeResult.attempts,
    };
  }

  // error or block → check if we have a stale snapshot to fall back to
  if (outcome.kind !== 'html') {
    if (activeSnapshot && !forceRescrape) {
      // Use stale snapshot as fallback per §10
      return {
        success: true,
        snapshotId: activeSnapshot.id,
        combinedDigest: activeSnapshot.combinedDigest,
        scrapeMs: Date.now() - startMs,
        proxyUsed: null,
        error: `Fresh scrape failed (${outcome.kind}), using stale cache`,
        isCache: true,
        skipReason: null,
        attempts: scrapeResult.attempts,
      };
    }

    const errorMsg = outcome.kind === 'error' ? outcome.error :
      outcome.kind === 'block' ? `Blocked: ${outcome.blockReason}` : 'Unknown scrape failure';

    await createFailedSnapshot(
      domain.id,
      errorMsg,
      'httpStatus' in outcome ? outcome.httpStatus : null,
      outcome.proxyName
    );

    return {
      success: false,
      snapshotId: null,
      combinedDigest: null,
      scrapeMs: Date.now() - startMs,
      proxyUsed: outcome.proxyName,
      error: errorMsg,
      isCache: false,
      skipReason: null,
      attempts: scrapeResult.attempts,
    };
  }

  // html → clean + create snapshot
  const homepage = cleanHtml(outcome.body);

  // Safety net: if cleaned content looks like a proxy service's own page,
  // refuse to create a snapshot. Fail cleanly so the AI doesn't classify the proxy itself.
  if (homepage.looksLikeProxyPage) {
    const err = 'Scraped content appears to be a proxy service page, not the target website.';
    await createFailedSnapshot(domain.id, err, outcome.httpStatus, outcome.proxyName);
    return {
      success: false,
      snapshotId: null,
      combinedDigest: null,
      scrapeMs: Date.now() - startMs,
      proxyUsed: outcome.proxyName,
      error: err,
      isCache: false,
      skipReason: null,
      attempts: scrapeResult.attempts,
    };
  }

  // Smart multi-page scraping
  const pagesToScrape = getInternalPagesToScrape(homepage.cleanedText.length);
  const internalPages: Array<{ path: string; title: string | null; cleanedText: string }> = [];

  for (const pagePath of pagesToScrape) {
    try {
      const pageResult = await scrapeUrl(`${domainName}${pagePath}`, runId);
      if (pageResult.outcome.kind === 'html') {
        const cleaned = cleanHtml(pageResult.outcome.body);
        internalPages.push({
          path: pagePath,
          title: cleaned.pageTitle,
          cleanedText: cleaned.cleanedText,
        });

        // Stop if we have enough content
        const totalChars = homepage.cleanedText.length +
          internalPages.reduce((sum, p) => sum + p.cleanedText.length, 0);
        if (totalChars >= 5000) break;
      }
    } catch {
      // Internal page scrape failure is non-fatal
    }
  }

  const site = buildCombinedDigest(homepage, internalPages);
  const snapshot = await createSnapshot(
    domain.id,
    site,
    outcome.httpStatus,
    outcome.proxyName
  );

  return {
    success: true,
    snapshotId: snapshot.id,
    combinedDigest: site.combinedDigest,
    scrapeMs: Date.now() - startMs,
    proxyUsed: outcome.proxyName,
    error: null,
    isCache: false,
    skipReason: null,
    attempts: scrapeResult.attempts,
  };
}

// ─── Proxy attempt event logging per §5.13 ──────────────────────────────────

async function logProxyAttempts(
  attempts: ProxyAttemptLog[],
  domain: string,
  runId: string | null
) {
  if (attempts.length === 0) return;

  await prisma.proxyAttemptEvent.createMany({
    data: attempts.map((a) => ({
      proxyId: a.proxyId,
      proxyName: a.proxyName,
      domain,
      runId,
      phase: a.phase,
      success: a.success,
      httpStatus: a.httpStatus,
      responseMs: a.responseMs,
      errorMessage: a.errorMessage,
      metadata: a.metadata === null ? Prisma.JsonNull : (a.metadata as Prisma.InputJsonValue),
    })),
  });

  // Update aggregate stats for Phase 1 DB proxies
  for (const attempt of attempts) {
    if (attempt.proxyId) {
      await prisma.$executeRawUnsafe(
        `UPDATE proxy_endpoints SET
          total_requests = total_requests + 1,
          success_count = success_count + CASE WHEN $1 THEN 1 ELSE 0 END,
          failure_count = failure_count + CASE WHEN $1 THEN 0 ELSE 1 END,
          avg_response_ms = CASE WHEN total_requests = 0 THEN $2
            ELSE ((avg_response_ms * total_requests) + $2) / (total_requests + 1) END,
          last_used_at = now(),
          last_error = CASE WHEN $1 THEN NULL ELSE $3 END
        WHERE id = $4::uuid`,
        attempt.success,
        attempt.responseMs,
        attempt.errorMessage,
        attempt.proxyId
      );
    }
  }
}
