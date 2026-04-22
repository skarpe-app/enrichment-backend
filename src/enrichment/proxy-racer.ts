import { ProxyAgent } from 'undici';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { decrypt } from '../utils/encryption.js';

// ─── CorsProxy.io paid (Phase 3 fallback) — from env var ───────────────────
const CORSPROXY_API_KEY = config.CORSPROXY_API_KEY;

// ─── Browser-like headers per §12 ────────────────────────────────────────────
const SCRAPE_HEADERS = {
  'User-Agent': config.SCRAPER_USER_AGENT ??
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
};

// ─── Typed Proxy Outcomes per §12 ────────────────────────────────────────────

export type ProxyOutcome =
  | { kind: 'html'; body: string; contentType: string; finalUrl: string; httpStatus: number; responseMs: number; proxyName: string }
  | { kind: 'non_html'; contentType: string; finalUrl: string; httpStatus: number; responseMs: number; proxyName: string }
  | { kind: 'block'; httpStatus: number; responseMs: number; proxyName: string; blockReason: 'access_denied' | 'js_required' | 'cloudflare_challenge' | 'too_short' | 'proxy_page' }
  | { kind: 'error'; error: string; responseMs: number; proxyName: string };

// ─── Block detection signatures ──────────────────────────────────────────────
const BLOCK_SIGNATURES: Array<{ pattern: RegExp; reason: ProxyOutcome & { kind: 'block' } extends { blockReason: infer R } ? R : never }> = [
  { pattern: /access\s*denied/i, reason: 'access_denied' },
  { pattern: /please\s+enable\s+javascript/i, reason: 'js_required' },
  { pattern: /cf-browser-verification|cloudflare/i, reason: 'cloudflare_challenge' },
];

/**
 * Detect when the proxy service returned ITS OWN page instead of proxying the target.
 * Happens on rate limits, errors, or when the proxy's landing page is served.
 *
 * Match only within <title>, <meta>, og:*, or top-of-body — not anywhere in body,
 * because legitimate websites may mention these words in content (e.g. a dev blog
 * writing about "CORS proxy" would get flagged otherwise).
 */
const PROXY_PAGE_SIGNATURES: RegExp[] = [
  // In <title>, <meta og:title/description> — these should only ever contain the
  // target website's branding, never the proxy service's.
  /<title[^>]*>[^<]*(?:corsproxy\.io|cors\s*proxy|codetabs|allorigins|corsfix|cors-anywhere)[^<]*<\/title>/i,
  /<meta\s+property=["']og:(?:site_name|title)["']\s+content=["'][^"']*(?:corsproxy\.io|codetabs|allorigins|corsfix)[^"']*["']/i,
  // Common proxy error pages
  /rate\s*limit\s*(?:exceeded|reached)\s*(?:on|for)?\s*(?:corsproxy|codetabs|allorigins|corsfix)/i,
  /you\s*(?:have\s*)?(?:exceeded|reached)\s*(?:the\s*)?(?:free\s*)?(?:daily\s*|monthly\s*)?limit.*(?:corsproxy|codetabs|allorigins|corsfix)/i,
  /(?:corsproxy\.io|allorigins\.win|corsfix\.com|api\.codetabs\.com).{0,200}(?:subscribe|upgrade|get\s*a\s*key|sign\s*up)/i,
];

// ─── Core fetch with validation per §12 ──────────────────────────────────────

async function fetchWithValidation(
  url: string,
  proxyName: string,
  signal: AbortSignal
): Promise<ProxyOutcome> {
  const start = Date.now();
  try {
    const response = await fetch(url, {
      headers: SCRAPE_HEADERS,
      redirect: 'follow',
      signal,
      // @ts-expect-error undici maxRedirections — enforces 10 redirect limit per §12
      maxRedirections: 10,
    });

    const responseMs = Date.now() - start;
    const contentType = response.headers.get('content-type') ?? '';
    const finalUrl = response.url;

    // Non-2xx
    if (!response.ok) {
      return { kind: 'error', error: `HTTP ${response.status}`, responseMs, proxyName };
    }

    // Content-type check
    const isHtml = contentType.includes('text/html') || contentType.includes('application/xhtml+xml') || !contentType;
    if (!isHtml) {
      return { kind: 'non_html', contentType, finalUrl, httpStatus: response.status, responseMs, proxyName };
    }

    const body = await response.text();

    // Too short check
    if (body.length < 200) {
      return { kind: 'block', httpStatus: response.status, responseMs, proxyName, blockReason: 'too_short' };
    }

    // Block signature check (generic bot-wall / cloudflare / etc.)
    for (const sig of BLOCK_SIGNATURES) {
      if (sig.pattern.test(body.substring(0, 2000))) {
        return { kind: 'block', httpStatus: response.status, responseMs, proxyName, blockReason: sig.reason };
      }
    }

    // Proxy-page detection: only for non-direct fetches (proxy adapters can return
    // their own branded page on error/rate-limit). Direct fetches are never proxy pages.
    if (proxyName !== 'direct') {
      const headSection = body.substring(0, 5000); // title + meta + top of body
      for (const pattern of PROXY_PAGE_SIGNATURES) {
        if (pattern.test(headSection)) {
          return { kind: 'block', httpStatus: response.status, responseMs, proxyName, blockReason: 'proxy_page' };
        }
      }
    }

    return { kind: 'html', body, contentType, finalUrl, httpStatus: response.status, responseMs, proxyName };
  } catch (err) {
    const responseMs = Date.now() - start;
    const message = err instanceof Error ? err.message : 'Unknown error';
    // Detect redirect loop (undici throws when maxRedirections exceeded)
    if (message.includes('redirect') || message.includes('maxRedirections')) {
      return { kind: 'error', error: 'redirect_loop', responseMs, proxyName };
    }
    return { kind: 'error', error: message, responseMs, proxyName };
  }
}

// ─── Timeout wrapper ─────────────────────────────────────────────────────────

function withTimeout(promise: Promise<ProxyOutcome>, timeoutMs: number): Promise<ProxyOutcome> {
  return new Promise((resolve) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      resolve({ kind: 'error', error: 'timeout', responseMs: timeoutMs, proxyName: '<timeout>' });
    }, timeoutMs);

    promise.then((result) => {
      clearTimeout(timer);
      resolve(result);
    }).catch(() => {
      clearTimeout(timer);
      resolve({ kind: 'error', error: 'promise_rejected', responseMs: Date.now(), proxyName: '<unknown>' });
    });
  });
}

// ─── Phase race resolver per §12 ────────────────────────────────────────────

async function racePhase(
  attempts: Promise<ProxyOutcome>[],
  timeoutMs: number
): Promise<ProxyOutcome> {
  const results = await Promise.allSettled(attempts.map((p) => withTimeout(p, timeoutMs)));
  const outcomes = results
    .filter((r): r is PromiseFulfilledResult<ProxyOutcome> => r.status === 'fulfilled')
    .map((r) => r.value);

  // Precedence: html > non_html > block > error (fastest within each tier)
  const htmls = outcomes.filter((o) => o.kind === 'html');
  if (htmls.length) return htmls.sort((a, b) => a.responseMs - b.responseMs)[0];

  const nonHtmls = outcomes.filter((o) => o.kind === 'non_html');
  if (nonHtmls.length) return nonHtmls.sort((a, b) => a.responseMs - b.responseMs)[0];

  const blocks = outcomes.filter((o) => o.kind === 'block');
  if (blocks.length) return blocks.sort((a, b) => a.responseMs - b.responseMs)[0];

  const errors = outcomes.filter((o) => o.kind === 'error');
  return errors[0] ?? { kind: 'error', error: 'all_attempts_failed', responseMs: 0, proxyName: '<none>' };
}

// ─── Adapter builders ────────────────────────────────────────────────────────

function directFetch(targetUrl: string, signal: AbortSignal): Promise<ProxyOutcome> {
  return fetchWithValidation(targetUrl, 'direct', signal);
}

/**
 * Fetch through a custom host-based proxy (HTTP/HTTPS/SOCKS5).
 * Uses undici ProxyAgent for HTTP CONNECT tunneling.
 */
function customProxyFetch(
  targetUrl: string,
  proxy: { id: string; name: string; host: string; port: number; protocol: string; usernameEnc: string | null; passwordEnc: string | null },
  signal: AbortSignal
): Promise<ProxyOutcome> {
  const start = Date.now();
  return (async () => {
    try {
      let auth = '';
      if (proxy.usernameEnc && proxy.passwordEnc) {
        const username = decrypt(proxy.usernameEnc);
        const password = decrypt(proxy.passwordEnc);
        auth = `${username}:${password}@`;
      }
      const proxyUrl = `${proxy.protocol}://${auth}${proxy.host}:${proxy.port}`;
      const agent = new ProxyAgent(proxyUrl);

      const response = await fetch(targetUrl, {
        headers: SCRAPE_HEADERS,
        redirect: 'follow',
        signal,
        // @ts-expect-error undici dispatcher
        dispatcher: agent,
      });

      const responseMs = Date.now() - start;
      const contentType = response.headers.get('content-type') ?? '';
      const finalUrl = response.url;

      if (!response.ok) {
        return { kind: 'error' as const, error: `HTTP ${response.status}`, responseMs, proxyName: proxy.name };
      }

      const isHtml = contentType.includes('text/html') || contentType.includes('application/xhtml+xml') || !contentType;
      if (!isHtml) {
        return { kind: 'non_html' as const, contentType, finalUrl, httpStatus: response.status, responseMs, proxyName: proxy.name };
      }

      const body = await response.text();

      if (body.length < 200) {
        return { kind: 'block' as const, httpStatus: response.status, responseMs, proxyName: proxy.name, blockReason: 'too_short' as const };
      }

      for (const sig of BLOCK_SIGNATURES) {
        if (sig.pattern.test(body.substring(0, 2000))) {
          return { kind: 'block' as const, httpStatus: response.status, responseMs, proxyName: proxy.name, blockReason: sig.reason };
        }
      }

      return { kind: 'html' as const, body, contentType, finalUrl, httpStatus: response.status, responseMs, proxyName: proxy.name };
    } catch (err) {
      const responseMs = Date.now() - start;
      return { kind: 'error' as const, error: err instanceof Error ? err.message : 'Proxy error', responseMs, proxyName: proxy.name };
    }
  })();
}

function corsproxyFree(targetUrl: string, signal: AbortSignal): Promise<ProxyOutcome> {
  const proxyUrl = `https://corsproxy.io/?${encodeURIComponent(targetUrl)}`;
  return fetchWithValidation(proxyUrl, 'corsproxy_free', signal);
}

function codetabs(targetUrl: string, signal: AbortSignal): Promise<ProxyOutcome> {
  const proxyUrl = `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(targetUrl)}`;
  return fetchWithValidation(proxyUrl, 'codetabs', signal);
}

function corsfix(targetUrl: string, signal: AbortSignal): Promise<ProxyOutcome> {
  const proxyUrl = `https://corsfix.com/?${encodeURIComponent(targetUrl)}`;
  return fetchWithValidation(proxyUrl, 'corsfix', signal);
}

function allorigins(targetUrl: string, signal: AbortSignal): Promise<ProxyOutcome> {
  const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(targetUrl)}`;
  return fetchWithValidation(proxyUrl, 'allorigins', signal);
}

function corsproxyPaid(targetUrl: string, signal: AbortSignal): Promise<ProxyOutcome> {
  const proxyUrl = `https://proxy.corsproxy.io/?key=${CORSPROXY_API_KEY}&url=${encodeURIComponent(targetUrl)}`;
  return fetchWithValidation(proxyUrl, 'corsproxy_paid', signal);
}

// ─── Main scrape function ────────────────────────────────────────────────────

export interface ScrapeResult {
  outcome: ProxyOutcome;
  attempts: ProxyAttemptLog[];
}

export interface ProxyAttemptLog {
  proxyId: string | null;
  proxyName: string;
  phase: number;
  success: boolean;
  httpStatus: number | null;
  responseMs: number;
  errorMessage: string | null;
  metadata: Record<string, unknown> | null;
}

/**
 * Run the 3-phase proxy race per §12.
 * Returns the best outcome + all attempt logs for proxy_attempt_events.
 */
export async function scrapeUrl(
  domain: string,
  runId: string | null
): Promise<ScrapeResult> {
  const targetUrl = `https://${domain}`;
  const allAttempts: ProxyAttemptLog[] = [];
  const controller = new AbortController();

  // ─── Phase 1: Custom proxies + direct fetch (8s) ────────────────────────
  const phase1Attempts: Promise<ProxyOutcome>[] = [];

  // Load admin proxies
  const proxies = await prisma.proxyEndpoint.findMany({
    where: { isActive: true },
    orderBy: { priority: 'desc' },
  });

  for (const proxy of proxies) {
    phase1Attempts.push(customProxyFetch(targetUrl, proxy, controller.signal));
  }
  // Always include direct fetch
  phase1Attempts.push(directFetch(targetUrl, controller.signal));

  const phase1Result = await racePhase(phase1Attempts, 8000);
  logAttempts(allAttempts, phase1Result, 1, null);

  // html → done, non_html → done (don't retry per §12)
  if (phase1Result.kind === 'html' || phase1Result.kind === 'non_html') {
    return { outcome: phase1Result, attempts: allAttempts };
  }

  // ─── Phase 2: Free adapters (8s) ───────────────────────────────────────
  const phase2Attempts = [
    corsproxyFree(targetUrl, controller.signal),
    codetabs(targetUrl, controller.signal),
    corsfix(targetUrl, controller.signal),
    allorigins(targetUrl, controller.signal),
  ];

  const phase2Result = await racePhase(phase2Attempts, 8000);
  logAttempts(allAttempts, phase2Result, 2, null);

  if (phase2Result.kind === 'html' || phase2Result.kind === 'non_html') {
    return { outcome: phase2Result, attempts: allAttempts };
  }

  // ─── Phase 3: CorsProxy.io paid (45s) — only if key is configured ────
  if (!CORSPROXY_API_KEY) {
    return { outcome: phase2Result, attempts: allAttempts };
  }
  const phase3Result = await racePhase(
    [corsproxyPaid(targetUrl, controller.signal)],
    45000
  );
  logAttempts(allAttempts, phase3Result, 3, null);

  return { outcome: phase3Result, attempts: allAttempts };
}

function logAttempts(
  allAttempts: ProxyAttemptLog[],
  outcome: ProxyOutcome,
  phase: number,
  proxyId: string | null
) {
  allAttempts.push({
    proxyId,
    proxyName: outcome.proxyName,
    phase,
    success: outcome.kind === 'html',
    httpStatus: 'httpStatus' in outcome ? outcome.httpStatus : null,
    responseMs: outcome.responseMs,
    errorMessage: outcome.kind === 'error' ? outcome.error : outcome.kind === 'block' ? outcome.blockReason : null,
    metadata: outcome.kind === 'html' ? { finalUrl: outcome.finalUrl } : null,
  });
}
