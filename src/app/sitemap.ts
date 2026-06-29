import type { MetadataRoute } from "next";
import { ROOMS, SITE } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return [
    { url: SITE.url, lastModified: now, changeFrequency: "monthly", priority: 1 },
    { url: `${SITE.url}/rooms`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
    ...ROOMS.map((room) => ({
      url: `${SITE.url}/rooms/${room.slug}`,
      lastModified: now,
      changeFrequency: "monthly" as const,
      priority: 0.6,
    })),
  ];
}
