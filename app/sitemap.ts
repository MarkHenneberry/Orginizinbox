import type { MetadataRoute } from "next";
import { siteConfig } from "@/lib/config";
import { marketingPages } from "@/lib/marketing-pages";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: siteConfig.url,
      changeFrequency: "weekly",
      priority: 1
    },
    ...marketingPages.filter((page) => page.slug !== "data-access").map((page) => ({
      url: `${siteConfig.url}/${page.slug}`,
      changeFrequency: "monthly" as const,
      priority: page.priority
    })),
    {
      url: `${siteConfig.url}/data-access`,
      changeFrequency: "monthly",
      priority: 0.8
    }
  ];
}
