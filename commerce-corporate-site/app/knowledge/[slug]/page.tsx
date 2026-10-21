import { SiteIcon } from "@/components/site-icon";
import { notFound } from "next/navigation";
import Link from "next/link";
import Markdown from "react-markdown";
import {
  getArticles,
  getArticle,
  headings,
  headingId,
  formatDate,
} from "@/lib/knowledge";
import { ArticleCard } from "@/components/knowledge";
import { site } from "@/lib/site";
export const dynamicParams = false;
export function generateStaticParams() {
  return getArticles().map((a) => ({ slug: a.slug }));
}
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const a = getArticle((await params).slug);
  if (!a) return {};
  return {
    title: a.title,
    description: a.summary,
    alternates: { canonical: `/knowledge/${a.slug}/` },
    openGraph: {
      title: a.title,
      description: a.summary,
      type: "article",
      publishedTime: a.date,
      authors: [a.author],
      tags: a.tags,
    },
  };
}
export default async function ArticlePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const a = getArticle((await params).slug);
  if (!a) notFound();
  const toc = headings(a.body);
  return (
    <div className="container article-page">
      <Link className="back-link" href="/knowledge/">
        <SiteIcon name="left" /> All knowledge
      </Link>
      <header className="article-header">
        <p className="eyebrow">{a.category} / PERSPECTIVES</p>
        <h1>{a.title}</h1>
        <p className="article-summary">{a.summary}</p>
        <div className="article-meta">
          <span>{a.author}</span>
          <time dateTime={a.date}>{formatDate(a.date)}</time>
          <span>{a.minutes} min read</span>
        </div>
        <div className="article-tags">
          {a.tags.map((t) => (
            <span key={t}>{t}</span>
          ))}
        </div>
      </header>
      <div className="article-layout">
        <aside className="toc">
          <nav aria-label="Table of contents">
            <p className="eyebrow">ON THIS PAGE</p>
            {toc.map((h) => (
              <a key={h.id} href={`#${h.id}`}>
                {h.title}
              </a>
            ))}
          </nav>
        </aside>
        <article className="prose">
          <Markdown
            components={{
              h2: ({ children }) => (
                <h2 id={headingId(String(children))}>{children}</h2>
              ),
              img: ({ src, alt }) => (
                <img src={src} alt={alt || ""} loading="lazy" />
              ),
              pre: ({ children }) => <pre tabIndex={0}>{children}</pre>,
            }}
          >
            {a.body}
          </Markdown>
        </article>
      </div>
      <section className="related">
        <h2>Keep exploring.</h2>
        <div className="article-grid">
          {getArticles()
            .filter((x) => x.slug !== a.slug)
            .slice(0, 3)
            .map((x) => (
              <ArticleCard key={x.slug} article={x} />
            ))}
        </div>
      </section>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@type": "Article",
            headline: a.title,
            description: a.summary,
            datePublished: a.date,
            author: { "@type": "Organization", name: a.author },
            publisher: { "@type": "Organization", name: site.name },
            mainEntityOfPage: new URL(`/knowledge/${a.slug}/`, site.url).href,
          }).replace(/</g, "\\u003c"),
        }}
      />
    </div>
  );
}
