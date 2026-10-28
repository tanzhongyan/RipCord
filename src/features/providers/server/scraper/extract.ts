import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

export interface ArticleText {
  title: string | null;
  text: string;
}

/**
 * Readable text for one fetched page: Readability over a linkedom document.
 * Returns an empty string when the page has no article content, so the
 * caller can skip model extraction for it.
 */
export function extractArticleText(html: string): ArticleText {
  const { document } = parseHTML(html);
  const article = new Readability(document as unknown as Document).parse();
  return {
    title: article?.title ?? null,
    text: (article?.textContent ?? "").replace(/\s+/g, " ").trim(),
  };
}

export interface CandidateLink {
  url: string;
  text: string;
}

/** Links worth following: same origin, matching text or target. */
const FOLLOW_PATTERN = /cancel|terminat|close account|contact|terms|policy/i;

/**
 * Same-domain links whose text or URL matches the follow pattern, resolved
 * to absolute URLs. Malformed targets are dropped.
 */
export function findCandidateLinks(html: string, pageUrl: string): CandidateLink[] {
  const base = new URL(pageUrl);
  const { document } = parseHTML(html);
  const found: CandidateLink[] = [];
  const seen = new Set<string>();
  const anchors = document.querySelectorAll("a");
  for (const anchor of anchors) {
    const href = anchor.getAttribute("href");
    if (!href) continue;
    let absolute: URL;
    try {
      absolute = new URL(href, base);
    } catch {
      continue;
    }
    if (absolute.origin !== base.origin) continue;
    if (absolute.protocol !== "http:" && absolute.protocol !== "https:") continue;
    const text = (anchor.textContent ?? "").replace(/\s+/g, " ").trim();
    if (!FOLLOW_PATTERN.test(text) && !FOLLOW_PATTERN.test(absolute.href)) continue;
    absolute.hash = "";
    const url = absolute.href;
    if (seen.has(url)) continue;
    seen.add(url);
    found.push({ url, text });
  }
  return found;
}
