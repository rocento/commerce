import type { ContentBlock, ThemeConfiguration } from '@commerce/api-client';
export type PublicProduct = { sku: string; parent_id: string | null; offer_eligible: boolean; price_diagnostic: string; id: string; slug: string; name: string; description: string; price: string; original_price?: string; product_type: string; currency: string; unit: string; category_id: string; image_id: string | null; image_alt: string | null; attributes: Record<string, string | number | boolean> };
export type PublicImage = { id: string; alt: string; width: number; height: number; variants: { width: number; height: number }[] };
export type PublicCategory = { parent_id: string | null; id: string; slug: string; name: string; description: string; thumbnail: string | null };
export type MerchantPage = { document_id: string; revision_id: string; purpose: string; title: string; url: string; updated_at: string; effective_date: string | null };
export type PublicMerchant = { legal_name: string; description: string; logo_id: string | null; email: string; telephone: string; country: string; region: string; locations: string[]; delivery_areas: string[]; social_profiles: string[]; pages: MerchantPage[] };
export type PublicSnapshot = {
  discovery_attribution_enabled?: boolean;
  interface_bundle?: unknown;
  merchant?: PublicMerchant | null; comparisons?: PublicProduct[];
  variant_dimensions: string[]; family: PublicProduct[]; parent_product: PublicProduct | null; structured_data: unknown;
  guides: { path: string; title: string }[];
  images: Record<string, PublicImage>; metadata: { title: string; description: string; image: string | null; warnings: string[] };
  schema_version: 1; installation_id: string; origin: string; locale: string; site_name: string; description: string;
  path: string; kind: 'home' | 'category' | 'product' | 'content' | 'missing'; status: number; location: string | null; canonical: { installation_id: string; locale: string; path: string; url: string; html: string; json_ld: string; sitemap: string; feed: string } | null; robots: string;
  theme: ThemeConfiguration; categories: PublicCategory[]; category_id: string | null; products: PublicProduct[]; collections: Record<string, PublicProduct[]>; product: PublicProduct | null;
  content: { id: string; revision_id?: string; updated_at?: string; title: string; blocks: ContentBlock[] } | null; page: number; has_next: boolean; availability: string;
};
