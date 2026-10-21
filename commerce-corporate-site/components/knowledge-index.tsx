"use client";
import { useState } from "react";
import type { Article } from "@/lib/knowledge";
import { ArticleCard } from "./knowledge";
export function KnowledgeIndex({
  articles,
}: {
  articles: Omit<Article, "body">[];
}) {
  const [category, setCategory] = useState("All");
  const categories = ["All", ...new Set(articles.map((a) => a.category))];
  const filtered = articles.filter(
    (a) => category === "All" || a.category === category,
  );
  return (
    <>
      <div
        className="filters"
        role="group"
        aria-label="Filter articles by topic"
      >
        {categories.map((c) => (
          <button
            key={c}
            aria-pressed={category === c}
            onClick={() => setCategory(c)}
          >
            {c}
          </button>
        ))}
      </div>
      <p className="result-count" aria-live="polite">
        {filtered.length} {filtered.length === 1 ? "article" : "articles"}
      </p>
      <div className="knowledge-grid">
        {filtered.map((a) => (
          <ArticleCard key={a.slug} article={a} />
        ))}
      </div>
    </>
  );
}
