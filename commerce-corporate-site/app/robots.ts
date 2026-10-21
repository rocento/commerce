import type { MetadataRoute } from "next";
import { site } from "@/lib/site";
export const dynamic = "force-static";
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      ...(process.env.SITE_URL ? { allow: "/" } : { disallow: "/" }),
    },
    sitemap: `${site.url.replace(/\/$/, "")}/sitemap.xml`,
  };
}
