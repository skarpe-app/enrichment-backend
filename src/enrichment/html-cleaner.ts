import * as cheerio from 'cheerio';

const MAX_CLEANED_TEXT = 5000;
const MAX_COMBINED_DIGEST = 8000;
const MIN_HOMEPAGE_CHARS = 500;

export interface CleanedPage {
  pageTitle: string | null;
  metaDescription: string | null;
  headings: string[];
  cleanedText: string;
  contentLength: number;
}

export interface CleanedSite {
  homepage: CleanedPage;
  internalPages: Array<{ path: string; title: string | null; cleanedText: string }>;
  pagesScraped: number;
  combinedDigest: string;
}

/**
 * Clean HTML and extract structured text per §5.10.
 * Strips scripts/styles/nav/footer, extracts title, meta, headings, visible text.
 */
export function cleanHtml(html: string): CleanedPage {
  const $ = cheerio.load(html);

  // Strip non-content elements
  $('script, style, noscript, iframe, svg, canvas, link, meta[http-equiv]').remove();
  $('nav, footer, header nav, .nav, .navbar, .footer, .cookie-banner, .cookie-consent').remove();
  $('[role="navigation"], [role="banner"]').remove();

  // Extract structured data
  const pageTitle = $('title').first().text().trim()
    || $('meta[property="og:title"]').attr('content')?.trim()
    || null;
  const metaDescription =
    $('meta[name="description"]').attr('content')?.trim() ||
    $('meta[property="og:description"]').attr('content')?.trim() ||
    null;

  const headings: string[] = [];
  $('h1, h2, h3').each((_, el) => {
    const text = $(el).text().trim();
    if (text && text.length < 200) headings.push(text);
  });

  // Extract visible text
  // Remove remaining non-visible elements
  $('aside, [aria-hidden="true"], .hidden, .sr-only').remove();

  let cleanedText = $('body').text()
    .replace(/\s+/g, ' ')
    .trim();

  // Truncate to max size
  if (cleanedText.length > MAX_CLEANED_TEXT) {
    cleanedText = cleanedText.substring(0, MAX_CLEANED_TEXT);
  }

  return {
    pageTitle,
    metaDescription,
    headings: headings.slice(0, 20), // Cap headings
    cleanedText,
    contentLength: html.length,
  };
}

/**
 * Build a site-level digest from homepage + optional internal pages per §5.10.
 *
 * Smart multi-page: if homepage < 500 chars visible text,
 * try /about, /services, /solutions (up to 3 pages).
 * Merge into combined_digest (~8000 chars max).
 */
export function buildCombinedDigest(
  homepage: CleanedPage,
  internalPages: Array<{ path: string; title: string | null; cleanedText: string }>
): CleanedSite {
  const parts: string[] = [];

  // Add homepage content
  if (homepage.pageTitle) parts.push(`Title: ${homepage.pageTitle}`);
  if (homepage.metaDescription) parts.push(`Description: ${homepage.metaDescription}`);
  if (homepage.headings.length > 0) parts.push(`Headings: ${homepage.headings.join(' | ')}`);
  parts.push(homepage.cleanedText);

  // Add internal pages
  for (const page of internalPages) {
    if (page.title) parts.push(`--- ${page.path} (${page.title}) ---`);
    else parts.push(`--- ${page.path} ---`);
    parts.push(page.cleanedText);
  }

  let combinedDigest = parts.join('\n\n');
  if (combinedDigest.length > MAX_COMBINED_DIGEST) {
    combinedDigest = combinedDigest.substring(0, MAX_COMBINED_DIGEST);
  }

  return {
    homepage,
    internalPages,
    pagesScraped: 1 + internalPages.length,
    combinedDigest,
  };
}

/**
 * Determine which internal pages to scrape based on homepage content length.
 */
export function getInternalPagesToScrape(homepageTextLength: number): string[] {
  if (homepageTextLength >= MIN_HOMEPAGE_CHARS) return [];
  return ['/about', '/services', '/solutions'];
}
