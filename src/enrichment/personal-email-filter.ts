/**
 * Personal email domains per §9.
 * Emails from these domains are never scraped — they're consumer accounts, not businesses.
 */
const PERSONAL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com',
  'yahoo.com', 'yahoo.co.uk',
  'hotmail.com', 'hotmail.co.uk',
  'outlook.com', 'live.com', 'msn.com',
  'aol.com',
  'icloud.com', 'me.com', 'mac.com',
  'mail.com',
  'zoho.com',
  'yandex.com',
  'protonmail.com', 'proton.me',
  'gmx.com', 'gmx.net',
  'fastmail.com',
  'tutanota.com',
  'hushmail.com',
  'inbox.com',
  'comcast.net',
  'verizon.net',
  'att.net',
  'sbcglobal.net',
  'cox.net',
  'charter.net',
  'earthlink.net',
  'optonline.net',
  'frontier.com',
  'windstream.net',
]);

export function isPersonalEmail(emailDomain: string): boolean {
  return PERSONAL_DOMAINS.has(emailDomain.toLowerCase());
}
