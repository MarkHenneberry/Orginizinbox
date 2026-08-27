import type { MetadataRoute } from "next";
import { siteConfig } from "@/lib/config";
import { marketingPages } from "@/lib/marketing-pages";

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return [
    {
      url: siteConfig.url,
      lastModified: now,
      changeFrequency: "weekly",
      priority: 1
    },
    ...marketingPages.filter((page) => page.slug !== "data-access").map((page) => ({
      url: `${siteConfig.url}/${page.slug}`,
      lastModified: now,
      changeFrequency: "monthly" as const,
      priority: page.priority
    })),
    {
      url: `${siteConfig.url}/data-access`,
      lastModified: now,
      changeFrequency: "monthly",
      priority: 0.8
    }
  ];
}
