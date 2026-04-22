import { prisma } from '../db.js';
import { config } from '../config.js';
import { isPersonalEmail } from './personal-email-filter.js';
import { scrapeDomain } from './scraper.js';
import { OpenAiProvider } from './ai/openai.provider.js';
import {
  findCachedClassification,
  upsertClassification,
  computePromptHash,
} from './domain-intelligence.service.js';
import { getDecryptedApiKey } from '../services/settings.service.js';
import { extractEmailDomain, extractWebsiteDomain } from '../utils/domain.js';
import {
  logStart, logScrape, logClassify, logDone,
  statsStart, statsDone,
} from './pipeline-logger.js';
import type { EnrichmentRun, EnrichmentRunItem, Contact } from '@prisma/client';

const aiProvider = new OpenAiProvider();

/**
 * Full enrich-contact pipeline per §10.
 * Handles: atomic claim → domain resolution → cache check → scrape → classify → store results.
 */
export async function enrichContact(runItemId: string): Promise<void> {
  const startedAt = Date.now();

  // ─── 1. LOAD CONTEXT + ATOMIC CLAIM ──────────────────────────────────────
  const claimed = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
    `UPDATE enrichment_run_items
     SET status = 'scraping', locked_at = now(), attempt_count = attempt_count + 1
     WHERE id = $1::uuid AND (
       status IN ('pending', 'retrying')
       OR (status IN ('scraping', 'classifying') AND locked_at < now() - interval '5 minutes')
     ) RETURNING id`,
    runItemId
  );

  if (claimed.length === 0) return; // Already claimed or completed

  const runItem = await prisma.enrichmentRunItem.findUnique({
    where: { id: runItemId },
    include: { contact: true, run: true },
  });
  if (!runItem || !runItem.run || !runItem.contact) return;

  const { run, contact } = runItem;

  // If run is stopped, exit silently
  if (run.status === 'stopped') return;

  logStart(runItemId, contact.emailDomain ?? contact.websiteDomain ?? null);
  statsStart();
  let finalStatus: 'completed' | 'failed' | 'skipped' = 'failed';
  let wasCacheHit = false;

  // Resolve API key
  const apiKey = run.billingSource === 'user_credential' && run.aiCredentialId
    ? await getDecryptedApiKey(run.aiCredentialId)
    : config.OPENAI_API_KEY;

  try {
    // ─── 2. DOMAIN RESOLUTION per §9 ────────────────────────────────────────
    const domainResult = resolveDomain(contact, run);

    if (domainResult.skip) {
      logScrape(runItemId, domainResult.domain ?? 'no-domain', {
        success: false, isCache: false, ms: 0, proxy: null, skipReason: domainResult.skipReason,
      });
      await finishItem(runItemId, run.id, contact.id, {
        status: 'skipped',
        skipReason: domainResult.skipReason!,
        scrapeStatus: 'skipped',
        domain: domainResult.domain,
        domainSource: domainResult.domainSource,
      });
      finalStatus = 'skipped';
      return;
    }

    const domain = domainResult.domain!;

    // Update run item with domain info
    await prisma.enrichmentRunItem.update({
      where: { id: runItemId },
      data: {
        domain,
        domainSource: domainResult.domainSource,
        fallbackDomain: domainResult.fallbackDomain,
        fallbackSource: domainResult.fallbackSource,
      },
    });

    // ─── 3-4. SCRAPE (with cache check inside scrapeDomain) ────────────────
    let scrapeResult = await scrapeDomain(
      domain,
      run.domainCacheTtlDays,
      run.forceRescrape,
      run.id
    );

    // Handle non-HTML → try fallback if combined mode
    if (!scrapeResult.success && scrapeResult.skipReason === 'non_html_content' && domainResult.fallbackDomain) {
      // Try fallback domain
      scrapeResult = await scrapeDomain(
        domainResult.fallbackDomain,
        run.domainCacheTtlDays,
        run.forceRescrape,
        run.id
      );
      await prisma.enrichmentRunItem.update({
        where: { id: runItemId },
        data: { fallbackAttempted: true },
      });
    }

    // Scrape failed → try fallback if available
    if (!scrapeResult.success && !scrapeResult.skipReason && domainResult.fallbackDomain && !scrapeResult.attempts.length) {
      scrapeResult = await scrapeDomain(
        domainResult.fallbackDomain,
        run.domainCacheTtlDays,
        run.forceRescrape,
        run.id
      );
      await prisma.enrichmentRunItem.update({
        where: { id: runItemId },
        data: { fallbackAttempted: true },
      });
    }

    logScrape(runItemId, domain, {
      success: scrapeResult.success,
      isCache: scrapeResult.isCache,
      ms: scrapeResult.scrapeMs,
      proxy: scrapeResult.proxyUsed,
      error: scrapeResult.error,
      skipReason: scrapeResult.skipReason,
    });

    if (scrapeResult.skipReason) {
      await finishItem(runItemId, run.id, contact.id, {
        status: 'skipped',
        skipReason: scrapeResult.skipReason,
        scrapeStatus: 'skipped',
        scrapeMs: scrapeResult.scrapeMs,
        proxyUsed: scrapeResult.proxyUsed,
      });
      finalStatus = 'skipped';
      return;
    }

    if (!scrapeResult.success || !scrapeResult.snapshotId || !scrapeResult.combinedDigest) {
      await finishItem(runItemId, run.id, contact.id, {
        status: 'failed',
        scrapeStatus: 'failed',
        scrapeError: scrapeResult.error ?? 'Scrape failed',
        scrapeMs: scrapeResult.scrapeMs,
        proxyUsed: scrapeResult.proxyUsed,
      });
      return;
    }

    // ─── 5. CLASSIFICATION CACHE CHECK (before setting classifying status per §5.8) ──
    const snapshot = await prisma.domainSnapshot.findUnique({ where: { id: scrapeResult.snapshotId } });
    if (!snapshot) {
      await finishItem(runItemId, run.id, contact.id, { status: 'failed', scrapeError: 'Snapshot not found after scrape' });
      return;
    }

    const cached = await findCachedClassification({
      snapshotId: snapshot.id,
      aiProvider: run.aiProvider,
      aiModel: run.aiModel,
      promptId: run.promptId,
      promptVersion: run.promptVersion,
      promptHash: run.promptHash,
    });

    if (cached) {
      // Cache hit → scraping → completed directly (skip classifying per §5.8)
      logClassify(runItemId, {
        cached: true, ms: 0, inputTokens: 0, outputTokens: 0, costUsd: 0,
        industry: cached.industry,
      });
      await finishItem(runItemId, run.id, contact.id, {
        status: 'completed',
        scrapeStatus: scrapeResult.isCache ? 'cached' : 'success',
        scrapeMs: scrapeResult.scrapeMs,
        proxyUsed: scrapeResult.proxyUsed,
        industry: cached.industry,
        subIndustry: cached.subIndustry,
        confidence: cached.confidence,
        reasoning: cached.reasoning,
        deltaInputTokens: 0,
        deltaOutputTokens: 0,
        deltaCostUsd: 0,
        classifyMs: 0,
        cacheHit: true,
      });
      finalStatus = 'completed';
      wasCacheHit = true;
      return;
    }

    // No cache hit — transition to classifying, then call AI
    await prisma.enrichmentRunItem.update({
      where: { id: runItemId },
      data: {
        status: 'classifying',
        scrapeStatus: scrapeResult.isCache ? 'cached' : 'success',
        scrapeMs: scrapeResult.scrapeMs,
        proxyUsed: scrapeResult.proxyUsed,
      },
    });

    // ─── 6. AI CLASSIFICATION ───────────────────────────────────────────────
    const classResult = await aiProvider.classify({
      combinedDigest: scrapeResult.combinedDigest,
      promptMode: run.promptMode,
      promptId: run.promptId,
      promptVersion: run.promptVersion,
      promptText: run.promptText,
      promptHash: run.promptHash,
      aiModel: run.aiModel,
      apiKey,
    });

    // Store classification
    await upsertClassification({
      domainId: snapshot.domainId,
      snapshotId: snapshot.id,
      aiProvider: run.aiProvider,
      aiModel: run.aiModel,
      promptId: run.promptId,
      promptVersion: run.promptVersion,
      promptHash: run.promptHash,
      industry: classResult.industry,
      subIndustry: classResult.subIndustry,
      confidence: classResult.confidence,
      reasoning: classResult.reasoning,
      inputTokens: classResult.inputTokens,
      outputTokens: classResult.outputTokens,
      costUsd: classResult.costUsd,
      classifyMs: classResult.classifyMs,
    });

    logClassify(runItemId, {
      cached: false,
      ms: classResult.classifyMs,
      inputTokens: classResult.inputTokens,
      outputTokens: classResult.outputTokens,
      costUsd: classResult.costUsd,
      industry: classResult.industry,
    });

    // ─── 7. STORE RESULTS ───────────────────────────────────────────────────
    await finishItem(runItemId, run.id, contact.id, {
      status: 'completed',
      scrapeStatus: scrapeResult.isCache ? 'cached' : 'success',
      scrapeMs: scrapeResult.scrapeMs,
      proxyUsed: scrapeResult.proxyUsed,
      industry: classResult.industry,
      subIndustry: classResult.subIndustry,
      confidence: classResult.confidence,
      reasoning: classResult.reasoning,
      deltaInputTokens: classResult.inputTokens,
      deltaOutputTokens: classResult.outputTokens,
      deltaCostUsd: classResult.costUsd,
      classifyMs: classResult.classifyMs,
    });
    finalStatus = 'completed';
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown pipeline error';
    logClassify(runItemId, {
      cached: false, ms: 0, inputTokens: 0, outputTokens: 0, costUsd: 0,
      error: errorMsg,
    });
    await finishItem(runItemId, run.id, contact.id, {
      status: 'failed',
      scrapeError: errorMsg,
    });
    finalStatus = 'failed';
  } finally {
    const totalMs = Date.now() - startedAt;
    logDone(runItemId, totalMs, finalStatus);
    statsDone(finalStatus, totalMs, wasCacheHit);
  }
}

// ─── Domain Resolution per §9 ───────────────────────────────────────────────

interface DomainResolution {
  domain: string | null;
  domainSource: 'email' | 'website' | null;
  fallbackDomain: string | null;
  fallbackSource: 'email' | 'website' | null;
  skip: boolean;
  skipReason: 'personal_email' | 'invalid_domain' | 'no_domain' | null;
}

function resolveDomain(contact: Contact, run: EnrichmentRun): DomainResolution {
  const emailDomain = contact.emailDomain;
  const websiteDomain = contact.websiteDomain;
  const isPersonal = emailDomain ? isPersonalEmail(emailDomain) : false;

  if (run.domainResolutionMode === 'email_only') {
    if (!emailDomain) return { domain: null, domainSource: null, fallbackDomain: null, fallbackSource: null, skip: true, skipReason: 'no_domain' };
    if (isPersonal) return { domain: emailDomain, domainSource: 'email', fallbackDomain: null, fallbackSource: null, skip: true, skipReason: 'personal_email' };
    return { domain: emailDomain, domainSource: 'email', fallbackDomain: null, fallbackSource: null, skip: false, skipReason: null };
  }

  if (run.domainResolutionMode === 'website_only') {
    if (!websiteDomain) return { domain: null, domainSource: null, fallbackDomain: null, fallbackSource: null, skip: true, skipReason: 'no_domain' };
    return { domain: websiteDomain, domainSource: 'website', fallbackDomain: null, fallbackSource: null, skip: false, skipReason: null };
  }

  // Combined mode
  const emailFirst = run.combinedPriority === 'email_first';
  const primary = emailFirst ? emailDomain : websiteDomain;
  const primarySource = emailFirst ? 'email' as const : 'website' as const;
  const secondary = emailFirst ? websiteDomain : emailDomain;
  const secondarySource = emailFirst ? 'website' as const : 'email' as const;

  if (emailFirst && isPersonal) {
    // Personal email → try website
    if (websiteDomain) return { domain: websiteDomain, domainSource: 'website', fallbackDomain: null, fallbackSource: null, skip: false, skipReason: null };
    return { domain: null, domainSource: null, fallbackDomain: null, fallbackSource: null, skip: true, skipReason: 'personal_email' };
  }

  if (!emailFirst && !websiteDomain) {
    // Website first but empty → try email
    if (emailDomain && !isPersonal) return { domain: emailDomain, domainSource: 'email', fallbackDomain: null, fallbackSource: null, skip: false, skipReason: null };
    if (emailDomain && isPersonal) return { domain: null, domainSource: null, fallbackDomain: null, fallbackSource: null, skip: true, skipReason: 'personal_email' };
    return { domain: null, domainSource: null, fallbackDomain: null, fallbackSource: null, skip: true, skipReason: 'no_domain' };
  }

  if (!primary) {
    if (secondary && !(emailFirst ? false : isPersonalEmail(secondary))) {
      return { domain: secondary, domainSource: secondarySource, fallbackDomain: null, fallbackSource: null, skip: false, skipReason: null };
    }
    return { domain: null, domainSource: null, fallbackDomain: null, fallbackSource: null, skip: true, skipReason: 'no_domain' };
  }

  // Both exist — set fallback if different
  const fallback = secondary && secondary !== primary && !(secondarySource === 'email' && isPersonalEmail(secondary))
    ? secondary : null;

  return {
    domain: primary,
    domainSource: primarySource,
    fallbackDomain: fallback,
    fallbackSource: fallback ? secondarySource : null,
    skip: false,
    skipReason: null,
  };
}

// ─── Finish item: update fields, increment counters, check completion ────────

interface FinishData {
  status: 'completed' | 'failed' | 'skipped';
  scrapeStatus?: string;
  scrapeError?: string;
  scrapeMs?: number;
  proxyUsed?: string | null;
  skipReason?: string;
  industry?: string;
  subIndustry?: string | null;
  confidence?: number;
  reasoning?: string;
  deltaInputTokens?: number;
  deltaOutputTokens?: number;
  deltaCostUsd?: number;
  classifyMs?: number;
  cacheHit?: boolean;
  domain?: string | null;
  domainSource?: string | null;
}

async function finishItem(
  runItemId: string,
  runId: string,
  contactId: string,
  data: FinishData
) {
  const deltaIn = data.deltaInputTokens ?? 0;
  const deltaOut = data.deltaOutputTokens ?? 0;
  const deltaCost = data.deltaCostUsd ?? 0;

  // Update run item
  await prisma.enrichmentRunItem.update({
    where: { id: runItemId },
    data: {
      status: data.status as any,
      lockedAt: null,
      finishedAt: new Date(),
      ...(data.scrapeStatus ? { scrapeStatus: data.scrapeStatus as any } : {}),
      ...(data.scrapeError ? { scrapeError: data.scrapeError } : {}),
      ...(data.scrapeMs !== undefined ? { scrapeMs: data.scrapeMs } : {}),
      ...(data.proxyUsed !== undefined ? { proxyUsed: data.proxyUsed } : {}),
      ...(data.skipReason ? { skipReason: data.skipReason as any } : {}),
      ...(data.status === 'failed' && data.scrapeError ? { errorMessage: data.scrapeError } : {}),
      ...(data.industry ? { industry: data.industry } : {}),
      ...(data.subIndustry !== undefined ? { subIndustry: data.subIndustry } : {}),
      ...(data.confidence !== undefined ? { confidence: data.confidence } : {}),
      ...(data.reasoning ? { reasoning: data.reasoning } : {}),
      ...(data.classifyMs !== undefined ? { classifyMs: data.classifyMs } : {}),
      // Cumulative token/cost fields (delta added to existing)
      ...(deltaIn > 0 ? { inputTokens: { increment: deltaIn } } : {}),
      ...(deltaOut > 0 ? { outputTokens: { increment: deltaOut } } : {}),
      ...(deltaCost > 0 ? { costUsd: { increment: deltaCost } } : {}),
    },
  });

  // Atomic counter increment + cost accumulation with RETURNING per §10 step 7
  const counterField = data.status === 'completed' ? 'completed_items'
    : data.status === 'failed' ? 'failed_items' : 'skipped_items';

  const updated = await prisma.$queryRawUnsafe<Array<{
    completed_items: number; failed_items: number; skipped_items: number; total_items: number; status: string;
  }>>(
    `UPDATE enrichment_runs
     SET ${counterField} = ${counterField} + 1,
         total_input_tokens = total_input_tokens + $2,
         total_output_tokens = total_output_tokens + $3,
         total_cost_usd = total_cost_usd + $4
     WHERE id = $1::uuid
     RETURNING completed_items, failed_items, skipped_items, total_items, status`,
    runId, deltaIn, deltaOut, deltaCost
  );

  if (updated.length === 0) return;
  const run = updated[0];

  // Write run event
  const step = data.cacheHit ? 'cache_hit' : data.status === 'skipped' ? 'skip' : data.status === 'failed' ? 'error' : 'classify';
  const eventStatus = data.cacheHit ? 'cached' : data.status === 'skipped' ? 'skipped' : data.status === 'failed' ? 'failed' : 'success';

  await prisma.runEvent.create({
    data: {
      runId,
      runItemId,
      contactId,
      step: step as any,
      status: eventStatus as any,
      message: data.industry
        ? `${data.industry} (${data.confidence}/10)`
        : data.skipReason ?? data.scrapeError ?? data.status,
      durationMs: data.classifyMs ?? data.scrapeMs,
    },
  });

  // If run is stopped → don't update contact pointers or auto-complete
  if (run.status === 'stopped') return;

  // Contact pointer writes (compare-and-set) per §10 step 7
  if (data.status === 'completed' || data.status === 'failed' || data.status === 'skipped') {
    await prisma.$executeRawUnsafe(
      `UPDATE contacts SET latest_result_id = $1::uuid
       WHERE id = $2::uuid AND (
         latest_result_id IS NULL
         OR (SELECT finished_at FROM enrichment_run_items WHERE id = contacts.latest_result_id) < (SELECT finished_at FROM enrichment_run_items WHERE id = $1::uuid)
       )`,
      runItemId, contactId
    );

    if (data.status === 'completed') {
      await prisma.$executeRawUnsafe(
        `UPDATE contacts SET latest_successful_result_id = $1::uuid
         WHERE id = $2::uuid AND (
           latest_successful_result_id IS NULL
           OR (SELECT finished_at FROM enrichment_run_items WHERE id = contacts.latest_successful_result_id) < (SELECT finished_at FROM enrichment_run_items WHERE id = $1::uuid)
         )`,
        runItemId, contactId
      );
    }
  }

  // Run completion detection (guarded UPDATE, single-writer) per §10 step 7
  const accounted = run.completed_items + run.failed_items + run.skipped_items;
  if (accounted >= run.total_items && run.status === 'processing') {
    await prisma.$executeRawUnsafe(
      `UPDATE enrichment_runs
       SET status = 'completed', completed_at = now()
       WHERE id = $1::uuid AND status = 'processing' AND scope_materialized = true
         AND completed_items + failed_items + skipped_items >= total_items`,
      runId
    );
  }
}
