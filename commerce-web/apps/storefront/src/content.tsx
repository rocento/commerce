import { useInterface } from './interface-locale';
import { type ReactNode } from "react";
import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { contentApi } from "@commerce/api-client";
import { Notice } from "@commerce/ui";
import "./content.css";
export { ContentBlocks } from "./content-blocks";
import { ContentBlocks } from "./content-blocks";
export function ManagedContent({
  name,
  fallback,
}: {
  name: string;
  fallback?: ReactNode;
}) {
  const {locale} = useInterface();
  const q = useQuery({
    queryKey: ["content", name, locale],
    queryFn: () => contentApi.public(name, locale),
    refetchInterval: 10000,
  });
  return q.data ? <ContentBlocks blocks={q.data.blocks} /> : <>{fallback}</>;
}
export function ContentPage() {
  const { key } = useParams();
  const {t: ui, message, locale} = useInterface();
  const q = useQuery({
    queryKey: ["content", key, locale],
    queryFn: () => contentApi.public(key!, locale),
    refetchInterval: 10000,
  });
  return (
    <main className="content-page">
      <Notice error>{message(q.error?.message || "")}</Notice>
      {q.isPending ? (
        <p>{ui("storefront.loading_page", "Loading page…")}</p>
      ) : q.data ? (
        <>
          <h1>{q.data.title}</h1>
          <ContentBlocks blocks={q.data.blocks} />
        </>
      ) : (
        !q.error && <h1>{ui("content.page_unavailable", "Page unavailable")}</h1>
      )}
    </main>
  );
}
