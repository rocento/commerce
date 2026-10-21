import { SiteIcon } from "@/components/site-icon";
import Link from "next/link";
import type { Article } from "@/lib/knowledge";
export function ArticleCard({ article }: { article: Omit<Article, "body"> }) {
  return (
    <Link className="article-card" href={`/knowledge/${article.slug}/`}>
      <div className="article-card-top">
        <span className="eyebrow">{article.category}</span>
        <span><SiteIcon /></span>
      </div>
      <h3>{article.title}</h3>
      <p>{article.summary}</p>
      <div className="article-card-bottom">
        <span>Rocento editorial</span>
        <span>{article.minutes} min read</span>
      </div>
    </Link>
  );
}
