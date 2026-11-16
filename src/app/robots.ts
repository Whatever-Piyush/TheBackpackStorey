import type { MetadataRoute } from "next";
import { SITE } from "@/lib/site";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      // Paused booking routes, machine endpoints and the staff portal.
      disallow: ["/book", "/booking/", "/api/", "/login", "/pos", "/stays", "/reception"],
    },
    sitemap: `${SITE.url}/sitemap.xml`,
  };
}
