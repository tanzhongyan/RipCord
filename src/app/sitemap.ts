import type { MetadataRoute } from "next";

import { site } from "~/shared/config/site";

/** Public routes only. App routes are never listed (see EXPERIENCE.md). */
export default function sitemap(): MetadataRoute.Sitemap {
  const pages = ["/", "/sign-in", "/privacy", "/terms", "/refund"];
  return pages.map((page) => ({ url: `${site.url}${page === "/" ? "" : page}` }));
}
