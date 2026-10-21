import { useInterface } from './interface-locale';
import { Megamenu } from './megamenu';
import { useMenuLocale } from './menu-locale';
import { contentApi, languagesApi, categoryNavigation, catalogApi, type Customer, type Product, type Category } from '@commerce/api-client';
import { StorefrontImage, productCardImageSizes } from './storefront-image';
import { CatalogPrice } from './product-price';
import { useTheme } from './themes';
import { useDeliveryStatus } from './locations';
import { track } from './analytics';
import { WishButton } from './community';
import { AddToCart } from './cart';
import { useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import './catalog-shared.css';

const shopperCategorySlugs = [
  "grocery-fruit",
  "grocery-vegetables",
  "grocery-dairy-eggs",
  "grocery-bakery",
  "grocery-pantry",
  "grocery-meat-poultry",
  "grocery-fish-seafood",
  "grocery-dates-nuts",
  "fresh-produce",
  "baladi-bakery",
  "egyptian-breakfast",
  "pantry-staples",
  "cheese-dairy",
  "dates-nuts-sweets",
  "tea-cold-drinks",
  "household-basics",
];
const shopperCategoryOrder = new Map(
  shopperCategorySlugs.map((slug, index) => [slug, index]),
);
type CustomerSegment = "guest" | "registered" | "verified";
const segmentCategorySlugs: Record<CustomerSegment, string[]> = {
  guest: ["fresh-produce", "baladi-bakery", "pantry-staples"],
  registered: ["fresh-produce", "pantry-staples", "egyptian-breakfast"],
  verified: ["pantry-staples", "cheese-dairy", "dates-nuts-sweets"],
};
const customerSegment = (customer?: Customer | null): CustomerSegment =>
  customer ? (customer.verified ? "verified" : "registered") : "guest";
const segmentRank = (slug: string, segment: CustomerSegment) => {
  const index = segmentCategorySlugs[segment].indexOf(slug);
  return index === -1 ? segmentCategorySlugs[segment].length : index;
};
export const shopperCategories = (
  categories: Category[],
  options: {
    availability?: Record<string, number>;
    customer?: Customer | null;
  } = {},
) => {
  const grocery = categories.filter((c) => c.slug.startsWith("grocery-") && shopperCategoryOrder.has(c.slug));
  const selected = grocery.length ? grocery : categories.filter((c) => shopperCategoryOrder.has(c.slug));
  const segment = customerSegment(options.customer);
  const availability = options.availability ?? {};
  return [...(selected.length ? selected : categories)].sort((a, b) => {
    const available = (availability[b.id] ?? 0) - (availability[a.id] ?? 0);
    if (available) return available;
    const ranked = segmentRank(a.slug, segment) - segmentRank(b.slug, segment);
    if (ranked) return ranked;
    return (
      (shopperCategoryOrder.get(a.slug) ?? Number.MAX_SAFE_INTEGER) -
      (shopperCategoryOrder.get(b.slug) ?? Number.MAX_SAFE_INTEGER)
    );
  });
};
export function BrowseAnalytics() {
  const location = useLocation();
  const last = useRef("");
  useEffect(() => {
    if (last.current === location.key) return;
    last.current = location.key;
    const p = location.pathname;
    if (
      p === "/" ||
      p === "/search" ||
      p.startsWith("/categories/") ||
      p.startsWith("/products/")
    )
      track("page_view", p);
  }, [location]);
  return null;
}
export { SearchBar } from "./search";
export function CategoryNav() {
  const { t: ui } = useInterface();
  const languages = useQuery({queryKey:["public-languages"],queryFn:languagesApi.public,refetchInterval:10000});
  const source = languages.data?.source_locale ?? 'en';
  const options = languages.data ? [source,...languages.data.languages.map(language=>language.locale).filter(locale=>locale!==source)] : ['en','ar'];
  const { locale } = useMenuLocale(languages.data || languages.isError ? options : undefined, source);
  const menu = useQuery({queryKey:["content","navigation",locale],queryFn:()=>contentApi.public("navigation",locale),refetchInterval:10000});
  const categories = useQuery({ queryKey: ["categories", locale], queryFn: () => catalogApi.categories(locale) });
  const fallback = categoryNavigation(categories.data ?? [], ui("storefront.shop_all", "Shop all"));
  return <Megamenu blocks={menu.data?.blocks ?? fallback} locale={locale}/>;
}
export function ProductCard({ product: p, customer, onClick }: { product: Product; customer?: Customer | null; onClick?: () => void }) {
  const { t: ui } = useInterface();
  const delivery=useDeliveryStatus();
  const theme = useTheme();
  const showcase = theme.global.top.some(s => s.enabled && s.component === "presentation" && s.settings.style === "showcase");
  const grocery = !theme.global.top.some(s => s.enabled && s.component === 'presentation' && ['heritage', 'showcase', 'editorial'].includes(String(s.settings.style)));
  const imageId = typeof p.attributes['demo-thumbnail'] === 'string' ? p.attributes['demo-thumbnail'] : p.media_ids[0];
  if (grocery) return <article className="product-card grocery-product-card">
    <Link to={`/products/${p.id}`} className="grocery-product-image-link" onClick={onClick}>
      <div className="product-image">
        {p.media_ids[0] ? <StorefrontImage id={imageId} metadata={p.images?.[imageId]} alt={p.name} sizes={productCardImageSizes} loading="lazy" /> : <span className="product-placeholder" aria-hidden="true">❧</span>}
        {p.product_type === 'simple' && !p.in_stock && <span className="stock-badge">{delivery.data?.configured ? ui("storefront.unavailable_in_your_area", "Unavailable in your area") : ui("product.out_of_stock", "Out of stock")}</span>}
      </div>
    </Link>
    {customer !== undefined && <div className="product-card-wishlist"><WishButton id={p.id} customer={customer} compact minimal /></div>}
    <div className="grocery-product-info">
      <small>{p.unit === 'each' ? ui("storefront.sold_individually", "Sold individually") : ui("product.sold_per", "Sold per {unit}", {unit:p.unit})}</small>
      <Link to={`/products/${p.id}`} className="grocery-product-title" onClick={onClick}><h3>{p.name}</h3></Link>
      <div className="grocery-product-footer">
        {p.product_type === 'simple' ? <><CatalogPrice product={p}/><AddToCart id={p.id} productName={p.name} compact /></> : <Link to={`/products/${p.id}`} className="grocery-product-options" onClick={onClick}>{p.product_type === 'configurable' ? ui("product.choose_options", "Choose options") : ui("storefront.choose_your_items", "Choose your items")} <span className="direction-icon" aria-hidden="true">→</span></Link>}
      </div>
    </div>
  </article>;
  return (
    <article className="product-card">
    <Link to={`/products/${p.id}`} className="product-card-main" onClick={onClick}>
      <div className="product-image">
        {p.media_ids[0] ? (
          <StorefrontImage id={imageId} metadata={p.images?.[imageId]} alt={p.name} sizes={productCardImageSizes} loading="lazy" />
        ) : (
          <span className="product-placeholder" aria-hidden="true">
            ❧
          </span>
        )}
        {p.product_type==="simple" && !p.in_stock && <span className="stock-badge">{delivery.data?.configured?ui("storefront.unavailable_in_your_area", "Unavailable in your area"):ui("product.out_of_stock", "Out of stock")}</span>}
      </div>
      <div className="product-copy">
        <small>
          {showcase ? String(p.attributes.brand || "Rocento Tech") : p.unit === "each" ? ui("storefront.sold_individually", "Sold individually") : ui("product.sold_per", "Sold per {unit}", {unit:p.unit})}
        </small>
        <h3>{p.name}</h3>
        <strong>
          {p.product_type==="simple"?<CatalogPrice product={p} showUnit={!showcase}/>:p.product_type==="configurable"?(showcase ? ui("product.choose_options", "Choose options") : ui("storefront.choose_a_size", "Choose a size")):ui("storefront.choose_your_items", "Choose your items")}
        </strong>
        {showcase && <span className="tech-card-stock">{p.in_stock ? ui("storefront.available_to_order", "Available to order") : ui("storefront.check_availability", "Check availability")}</span>}
        <span className="view-product">{ui("storefront.view_product", "View product ↗")}</span>
      </div>
    </Link>
    {customer !== undefined && <div className="product-card-wishlist"><WishButton id={p.id} customer={customer} compact /></div>}
    </article>
  );
}
