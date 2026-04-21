// Use URL constructor for IDN → punycode conversion (avoids deprecated node:punycode)
function toASCII(domain: string): string {
  try {
    const url = new URL(`http://${domain}`);
    return url.hostname;
  } catch {
    throw new Error('Invalid domain');
  }
}

/**
 * Domain normalization per §9:
 * 1. Trim + lowercase
 * 2. Strip protocol (http:// or https://)
 * 3. Strip leading www.
 * 4. Strip path, query, fragment, trailing slash
 * 5. Strip all ports
 * 6. IDN punycode normalization
 * 7. Reject invalid (localhost, IPs, single-label, .local/.test/.example)
 * 8. Keep all other subdomains
 */
export function normalizeDomain(input: string): string | null {
  if (!input) return null;

  // 1. Trim + lowercase
  let domain = input.trim().toLowerCase();
  if (!domain) return null;

  // 2. Strip protocol
  domain = domain.replace(/^https?:\/\//i, '');

  // 4. Strip path, query, fragment (do before port strip so we don't confuse path colons)
  // Take only the host part (before first /)
  const slashIndex = domain.indexOf('/');
  if (slashIndex !== -1) {
    domain = domain.substring(0, slashIndex);
  }

  // Also strip query/fragment if they appear without path (edge case)
  const queryIndex = domain.indexOf('?');
  if (queryIndex !== -1) domain = domain.substring(0, queryIndex);
  const hashIndex = domain.indexOf('#');
  if (hashIndex !== -1) domain = domain.substring(0, hashIndex);

  // 5. Strip all ports
  domain = domain.replace(/:\d+$/, '');

  // 3. Strip leading www. (only www., not other subdomains)
  domain = domain.replace(/^www\./, '');

  if (!domain) return null;

  // 6. IDN punycode normalization
  try {
    domain = toASCII(domain);
  } catch {
    return null; // Invalid IDN
  }

  // 7. Reject invalid domains
  if (isInvalidDomain(domain)) return null;

  return domain;
}

/**
 * Extract domain from an email address.
 * Returns normalized domain or null.
 */
export function extractEmailDomain(email: string): string | null {
  if (!email) return null;
  const atIndex = email.lastIndexOf('@');
  if (atIndex === -1) return null;
  const domain = email.substring(atIndex + 1);
  return normalizeDomain(domain);
}

/**
 * Extract domain from a website URL.
 * Returns normalized domain or null.
 */
export function extractWebsiteDomain(website: string): string | null {
  if (!website) return null;
  return normalizeDomain(website);
}

function isInvalidDomain(domain: string): boolean {
  // Reject localhost
  if (domain === 'localhost') return true;

  // Reject IP addresses (v4 and v6)
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(domain)) return true;
  if (domain.startsWith('[') || domain.includes(':')) return true;

  // Reject single-label hostnames (no dots)
  if (!domain.includes('.')) return true;

  // Reject reserved TLDs
  const reservedTLDs = ['.local', '.test', '.example', '.invalid', '.localhost'];
  for (const tld of reservedTLDs) {
    if (domain.endsWith(tld)) return true;
  }

  return false;
}
