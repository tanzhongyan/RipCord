import type { ModelExtraction } from "./model";

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export interface QuoteFilterResult {
  extraction: ModelExtraction;
  /** Addresses and policy kinds dropped for a missing or absent quote. */
  dropped: string[];
}

/**
 * Quote-verbatim check: a field stays only when its quote appears verbatim
 * in the page text. Whitespace runs collapse on both sides, so line breaks
 * in the source cannot hide a genuine quote.
 */
export function filterExtractionByQuotes(
  extraction: ModelExtraction,
  pageText: string,
): QuoteFilterResult {
  const haystack = normalize(pageText);
  const dropped: string[] = [];
  const channels = extraction.channels.filter((channel) => {
    const quote = normalize(channel.quote);
    if (!quote || !haystack.includes(quote)) {
      dropped.push(`channel:${channel.address}`);
      return false;
    }
    return true;
  });
  const policies = extraction.policies.filter((policy) => {
    const quote = normalize(policy.quote);
    if (!quote || !haystack.includes(quote)) {
      dropped.push(`policy:${policy.kind}`);
      return false;
    }
    return true;
  });
  return { extraction: { channels, policies }, dropped };
}
