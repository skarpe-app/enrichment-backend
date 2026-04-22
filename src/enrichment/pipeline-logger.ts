/**
 * Structured logging for the enrich-contact pipeline.
 * Emits one log line per phase + a periodic summary every 30s.
 *
 * Output format (plain text, easy to scan in Render logs):
 *   [14:32:05] [abc12345] acme.com  scrape:miss  phase1  1.2s  success
 *   [14:32:06] [def67890] gmail.com skip         -       -     personal_email
 *   [14:32:08] [abc12345] acme.com  ai          gpt-4.1-mini  2.1s  in=1847 out=94  $0.0012
 *   [14:32:08] [abc12345] DONE completed 3.3s
 *
 * Summary (every 30s):
 *   [14:32:30] SUMMARY  active=15  done=142 (completed=120 failed=18 skipped=4)  cache_hits=58 (40.8%)  avg=4.2s  err_rate=12.7%
 */

const pad = (n: number) => String(n).padStart(2, '0');
const ts = () => {
  const d = new Date();
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
};

const shortId = (id: string) => id.slice(0, 8);

export function logStart(runItemId: string, domain: string | null) {
  console.log(`[${ts()}] [${shortId(runItemId)}] START ${domain ?? '-'}`);
}

export function logScrape(runItemId: string, domain: string, result: {
  success: boolean;
  isCache: boolean;
  ms: number;
  proxy: string | null;
  error?: string | null;
  skipReason?: string | null;
}) {
  const status = result.isCache ? 'cache:hit' : result.success ? 'scrape:ok' : 'scrape:fail';
  const detail = result.skipReason
    ? `skip=${result.skipReason}`
    : result.error
      ? `error="${result.error.slice(0, 80)}"`
      : `proxy=${result.proxy ?? 'n/a'}`;
  console.log(`[${ts()}] [${shortId(runItemId)}] ${domain.padEnd(30).slice(0, 30)} ${status.padEnd(12)} ${(result.ms + 'ms').padStart(7)}  ${detail}`);
}

export function logClassify(runItemId: string, result: {
  cached: boolean;
  ms: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  industry?: string | null;
  error?: string | null;
}) {
  if (result.cached) {
    console.log(`[${ts()}] [${shortId(runItemId)}] classify:cache_hit  industry="${(result.industry ?? '').slice(0, 40)}"`);
    return;
  }
  if (result.error) {
    console.log(`[${ts()}] [${shortId(runItemId)}] classify:fail  ${(result.ms + 'ms').padStart(7)}  error="${result.error.slice(0, 80)}"`);
    return;
  }
  console.log(
    `[${ts()}] [${shortId(runItemId)}] classify:ok    ${(result.ms + 'ms').padStart(7)}  tok=${result.inputTokens}/${result.outputTokens}  $${result.costUsd.toFixed(4)}  industry="${(result.industry ?? '').slice(0, 40)}"`
  );
}

export function logDone(runItemId: string, totalMs: number, finalStatus: string) {
  console.log(`[${ts()}] [${shortId(runItemId)}] DONE ${finalStatus}  ${totalMs}ms`);
}

// ─── Stats aggregator ──────────────────────────────────────────────────────

interface Stats {
  active: number;
  startedTotal: number;
  doneTotal: number;
  completed: number;
  failed: number;
  skipped: number;
  cacheHits: number;
  totalDurationMs: number;
  errors: number;
}

const stats: Stats = {
  active: 0,
  startedTotal: 0,
  doneTotal: 0,
  completed: 0,
  failed: 0,
  skipped: 0,
  cacheHits: 0,
  totalDurationMs: 0,
  errors: 0,
};

export function statsStart() {
  stats.active++;
  stats.startedTotal++;
}

export function statsDone(status: 'completed' | 'failed' | 'skipped', durationMs: number, cacheHit: boolean) {
  stats.active = Math.max(0, stats.active - 1);
  stats.doneTotal++;
  stats.totalDurationMs += durationMs;
  if (status === 'completed') stats.completed++;
  else if (status === 'failed') { stats.failed++; stats.errors++; }
  else stats.skipped++;
  if (cacheHit) stats.cacheHits++;
}

// Summary interval — every 30s log a compact summary
let summaryTimer: NodeJS.Timeout | null = null;

export function startSummaryLogger() {
  if (summaryTimer) return;
  summaryTimer = setInterval(() => {
    if (stats.active === 0 && stats.doneTotal === 0) return; // nothing to report
    const avgMs = stats.doneTotal > 0 ? Math.round(stats.totalDurationMs / stats.doneTotal) : 0;
    const errRate = stats.doneTotal > 0 ? ((stats.errors / stats.doneTotal) * 100).toFixed(1) : '0.0';
    const cacheRate = stats.doneTotal > 0 ? ((stats.cacheHits / stats.doneTotal) * 100).toFixed(1) : '0.0';
    const ratePerMin = stats.doneTotal > 0
      ? (stats.doneTotal / ((Date.now() - startTime) / 60_000)).toFixed(1)
      : '0.0';
    console.log(
      `[${ts()}] SUMMARY  active=${stats.active}  done=${stats.doneTotal} (ok=${stats.completed} fail=${stats.failed} skip=${stats.skipped})  cache_hits=${stats.cacheHits} (${cacheRate}%)  avg=${(avgMs / 1000).toFixed(1)}s  err_rate=${errRate}%  rate=${ratePerMin}/min`
    );
  }, 30_000);
}

const startTime = Date.now();

export function stopSummaryLogger() {
  if (summaryTimer) {
    clearInterval(summaryTimer);
    summaryTimer = null;
  }
}
