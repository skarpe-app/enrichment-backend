import dns from 'node:dns/promises';
import { prisma } from '../db.js';

/**
 * DNS pre-check per §12.
 * Uses resolve4() (IPv4 A records only). IPv6-only domains marked invalid (v1 trade-off).
 *
 * Fast-path: if dns_valid=false and dns_checked_at < 1 hour ago, skip DNS call.
 */
export async function checkDns(domain: string): Promise<{ valid: boolean; cached: boolean }> {
  // Try to find existing domain record with recent DNS check
  const existing = await prisma.domain.findUnique({
    where: { domain },
    select: { id: true, dnsValid: true, dnsCheckedAt: true },
  });

  // Fast-path: recent failure (< 1 hour) → skip DNS call
  if (existing?.dnsValid === false && existing.dnsCheckedAt) {
    const ageMs = Date.now() - existing.dnsCheckedAt.getTime();
    if (ageMs < 60 * 60 * 1000) {
      return { valid: false, cached: true };
    }
  }

  // Perform DNS lookup
  let valid = false;
  const dnsStart = Date.now();
  try {
    const addresses = await dns.resolve4(domain);
    valid = addresses.length > 0;
  } catch (err) {
    valid = false;
    const code = (err as NodeJS.ErrnoException)?.code ?? 'UNKNOWN';
    console.log(`[FastFail] ${domain.padEnd(40).slice(0, 40)} DNS=${code.padEnd(10)} ${(Date.now() - dnsStart + 'ms').padStart(6)}`);
  }

  // Upsert domain record — create if not exists, update if exists
  await prisma.domain.upsert({
    where: { domain },
    create: { domain, dnsValid: valid, dnsCheckedAt: new Date() },
    update: { dnsValid: valid, dnsCheckedAt: new Date() },
  });

  return { valid, cached: false };
}
