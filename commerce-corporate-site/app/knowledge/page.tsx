import { BrandLogo } from "@/components/brand-logo";
import { getArticles } from "@/lib/knowledge";
import { KnowledgeIndex } from "@/components/knowledge-index";
export const metadata = {
  title: "Knowledge",
  description:
    "Notes on AI-native commerce, agentic systems, behavioral data and the architecture connecting them.",
  alternates: { canonical: "/knowledge/" },
  openGraph: {
    title: "Rocento Knowledge",
    description: "Ideas and engineering notes behind AI-native commerce.",
  },
};
export default function Knowledge() {
  return (
    <div className="container page-content">
      <header className="page-hero">
        <p className="eyebrow">RESEARCH / ENGINEERING / IDEAS</p>
        <h1>
          Rocento <em>Knowledge.</em>
        </h1>
        <p>
          Exploring the systems behind intelligent commerce.
          <br />
          Architecture, context, and what comes next.
        </p>
      </header>
      <KnowledgeIndex
        articles={getArticles().map(({ body, ...article }) => {
          void body;
          return article;
        })}
      />
      <div className="knowledge-note">
        <BrandLogo iconOnly />
        <p>
          Working ideas, clearly explained. These introductory essays describe
          our architectural approach, not independent research findings or
          production benchmarks.
        </p>
      </div>
    </div>
  );
}
