import { useInterface } from './interface-locale';
import type { Product } from "@commerce/api-client";
import "./product-price.css";
import { catalogPrice } from "./catalog-price";

export function ProductPrice({ price, originalPrice, currency, unit }: { price: string; originalPrice?: string | null; currency: string; unit?: string }) {
  const { t: ui, locale } = useInterface();
  const current = Number(price), original = Number(originalPrice);
  const discounted = !!originalPrice && Number.isFinite(original) && Number.isFinite(current) && original > current && current >= 0;
  const format = (amount: number) => /^[A-Z]{3}$/.test(currency)
    ? new Intl.NumberFormat(locale === "ar" ? "ar" : "en-US", { style: "currency", currency }).format(amount)
    : `${amount.toFixed(2)} ${currency}`.trim();
  return <span className={`product-price${discounted ? " product-price-sale" : ""}`}>
    {discounted && <span className="product-price-before"><span className="price-sr-only">{ui("storefront.original_price", "Original price:")} </span><del>{format(original)}</del><span className="product-price-badge">{new Intl.NumberFormat(locale === "ar" ? "ar" : "en-US", { maximumFractionDigits: 1 }).format((original - current) / original * 100)}{ui("storefront.off", "% off")}</span></span>}
    <span className="product-price-current"><span className="price-sr-only">{discounted ? ui("product.discounted_price", "Discounted price: ") : ui("product.price_label", "Price: ")}</span>{format(current)}{unit && <span className="product-price-unit"> / {unit === "each" ? ui("product.unit_each", "each") : unit}</span>}</span>
    {discounted && <span className="product-price-saving">{ui("storefront.you_save", "You save")} {format(original - current)}</span>}
  </span>;
}
export function CatalogPrice({ product, showUnit = true }: { product: Product; showUnit?: boolean }) {
  return <ProductPrice {...catalogPrice(product)} currency={product.currency} unit={showUnit ? product.unit : undefined}/>;
}
