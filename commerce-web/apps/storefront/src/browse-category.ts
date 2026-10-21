import type { Category } from "@commerce/api-client";

export function resolveBrowseCategory(categories: Category[], reference?: string): Category | undefined {
  if (!reference) return undefined;
  return categories.find(category => category.id === reference || category.slug === reference);
}

/** Repeated category parameters preserve selections across reloads and browser history. */
export function browseCategoryReferences(params: URLSearchParams): string[] {
  return [...new Set(params.getAll("category").filter(Boolean))];
}

export function replaceBrowseCategories(params: URLSearchParams, references: string[]): URLSearchParams {
  const next = new URLSearchParams(params);
  next.delete("category");
  for (const reference of [...new Set(references.filter(Boolean))]) next.append("category", reference);
  next.delete("offset");
  return next;
}
