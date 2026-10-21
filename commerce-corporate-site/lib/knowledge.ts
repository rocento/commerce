import fs from "node:fs";
import path from "node:path";
export type Article = {
  slug: string;
  title: string;
  summary: string;
  author: string;
  date: string;
  category: string;
  tags: string[];
  minutes: number;
  body: string;
};
const directory = path.join(process.cwd(), "content/knowledge");
export function getArticles(): Article[] {
  return fs
    .readdirSync(directory)
    .filter((f) => f.endsWith(".txt"))
    .map((file) => {
      const raw = fs.readFileSync(path.join(directory, file), "utf8");
      const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      if (!match) throw new Error(`Invalid article: ${file}`);
      const meta = JSON.parse(match[1]);
      for (const key of ["title", "summary", "author", "date", "category"])
        if (typeof meta[key] !== "string")
          throw new Error(`Missing ${key}: ${file}`);
      return {
        ...meta,
        slug: file.replace(/\.txt$/, ""),
        body: match[2],
        minutes: Math.max(1, Math.ceil(match[2].split(/\s+/).length / 200)),
      };
    })
    .sort(
      (a, b) =>
        [
          "ai-native-commerce",
          "commerce-context",
          "agentic-commerce",
          "behavioral-data",
        ].indexOf(a.slug) -
        [
          "ai-native-commerce",
          "commerce-context",
          "agentic-commerce",
          "behavioral-data",
        ].indexOf(b.slug),
    );
}
export function getArticle(slug: string) {
  return getArticles().find((a) => a.slug === slug);
}
export function headingId(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}
export function headings(body: string) {
  return [...body.matchAll(/^## (.+)$/gm)].map((m) => ({
    title: m[1],
    id: headingId(m[1]),
  }));
}
export function formatDate(date: string) {
  return new Date(date + "T00:00:00Z").toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}
