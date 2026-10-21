import type { MetadataRoute } from "next";
import { getArticles } from "@/lib/knowledge";
import { site } from "@/lib/site";
import { features, industries } from "@/lib/discovery";
import { docs } from "@/lib/docs";
export const dynamic = "force-static";
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    "",
    "platform/",
    "about/",
    "team/",
    "knowledge/",
    "features/", ...features.map((x)=>`features/${x.slug}/`),
    "industries/", ...industries.map((x)=>`industries/${x.slug}/`),
    "docs/", ...docs.map((x)=>`docs/${x.slug}/`),
    "pricing/", "security/", "integrations/", "changelog/", "demo/",
    ...getArticles().map((a) => `knowledge/${a.slug}/`),
  ].map((route) => ({ url: `${site.url.replace(/\/$/, "")}/${route}` }));
}
