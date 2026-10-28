import { describe, expect, it } from "vitest";

import { extractArticleText, findCandidateLinks } from "./extract";

const PAGE = `<!doctype html><html><head><title>Help: cancel your plan</title></head><body>
<nav><a href="/home">Home</a></nav>
<article><h1>How to cancel</h1>
<p>To cancel your mobile plan, email cancel@example.com at least 30 days before billing.</p>
<p>Early termination fees apply within the minimum term.</p>
<a href="/cancel-form">Start your cancellation request</a>
<a href="/terms">Terms and conditions</a>
<a href="https://other.example.com/cancel">Outside our domain</a>
<a href="mailto:cancel@example.com">Email us</a>
<a href="/cancel-form#top">Same form again</a>
<a href=":::bad">Broken link</a>
</article></body></html>`;

describe("extractArticleText", () => {
  it("keeps the article sentences for the model", () => {
    const article = extractArticleText(PAGE);
    expect(article.title).toBe("Help: cancel your plan");
    expect(article.text).toContain("email cancel@example.com at least 30 days before billing");
  });

  it("returns empty text without article content", () => {
    expect(extractArticleText("<html><body></body></html>").text).toBe("");
  });
});

describe("findCandidateLinks", () => {
  it("follows same-domain matching links once", () => {
    const links = findCandidateLinks(PAGE, "https://help.example.com/guide");
    const urls = links.map((link) => link.url).sort();
    expect(urls).toEqual([
      "https://help.example.com/cancel-form",
      "https://help.example.com/terms",
    ]);
    expect(links.find((link) => link.url.endsWith("/cancel-form"))?.text).toContain(
      "cancellation request",
    );
  });

  it("resolves relative targets against the page", () => {
    const links = findCandidateLinks(
      '<a href="contact">Contact us</a>',
      "https://x.example.com/a/b",
    );
    expect(links).toEqual([{ url: "https://x.example.com/a/contact", text: "Contact us" }]);
  });
});
