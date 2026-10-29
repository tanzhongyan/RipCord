import type { MetadataRoute } from "next";

import { site } from "~/shared/config/site";

const appRoutes = [
  "/dashboard",
  "/cases",
  "/chat",
  "/billing",
  "/settings",
  "/admin",
  "/m/",
  "/oauth/",
  "/api/",
];

const crawlers = ["*", "GPTBot", "ClaudeBot", "PerplexityBot", "Google-Extended"];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: crawlers.map((userAgent) => ({ userAgent, allow: "/", disallow: appRoutes })),
    sitemap: `${site.url}/sitemap.xml`,
  };
}
