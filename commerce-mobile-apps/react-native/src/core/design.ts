// Core-owned presentation data. Transport and credentials belong to adapters.
export type LocalizedCopy = { en: string; ar: string };
export type DesignColors = Record<'primary' | 'onPrimary' | 'background' | 'surface' | 'text', string>;
export type DesignAction = { type: 'openProduct'; productId: string } | { type: 'openCategory'; categoryId: string } | { type: 'openTab'; tab: 'home' | 'categories' | 'deals' | 'cart' | 'account' | 'wishlist' };
type Editorial = { heading?: LocalizedCopy; body?: LocalizedCopy; eyebrow?: LocalizedCopy; label?: LocalizedCopy; appearance?: 'editorial' | 'campaign'; action?: DesignAction; path?: string };
export type DesignSection = { id: string } & (
  | ({ type: 'richText'; text: LocalizedCopy } & Editorial)
  | ({ type: 'heroBanner'; image: string; additionalImages?: string[]; layout?: 'horizontal' | 'portrait'; imageFit?: 'cover' | 'contain'; accessibilityLabel: LocalizedCopy } & Editorial)
  | { type: 'productGrid' | 'productCarousel'; title: LocalizedCopy; collection: string; columns: number; limit: number }
  | { type: 'categoryGrid'; title: LocalizedCopy; categories: string[]; appearance: 'list' | 'tiles' }
  | { type: 'spacer'; size: number }
);
export interface StorefrontDesign {
  productActions?: { wishlist: boolean; compare: boolean };
  colors: DesignColors;
  darkColors?: DesignColors;
  radius: number;
  spacing: number;
  sections: DesignSection[];
}
