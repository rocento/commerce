import { ProductRelationships } from "./product-relationships";
import { attributeFiltersFromForm, removeAttributeFilter } from "./attribute-filters";
import { browseCategoryReferences, replaceBrowseCategories, resolveBrowseCategory } from "./browse-category";
import { shoppingLocationKey } from './interface-routing';
import { useInterface } from './interface-locale';
import { productQuery } from "./storefront-bootstrap";
import { StorefrontImage, productDetailImageSizes } from './storefront-image';
import { PurchaseAssurance } from "./purchase-assurance";
import { CompareButton } from "./comparison";
import { CatalogPrice } from "./product-price";
import { useTheme } from "./themes";
import { PriceFilter } from "./price-filter";
import {useDeliveryKey} from "./locations";
import { ProductOptions, ProductSort, CustomFilters, DisplayAttributes } from "./product-types";
import { track } from "./analytics";
import { ManagedContent } from "./content";
import { WishButton, ProductReviews } from "./community";
import type { Customer } from "@commerce/api-client";
import { AddToCart } from "./cart";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Link,
  useLocation,
  useNavigationType,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  catalogApi,
  type Category,
  type SearchInput,
} from "@commerce/api-client";
import { Notice } from "@commerce/ui";
import "./catalog.css";
import { ProductCard, shopperCategories } from './catalog';
import { ProductLoading } from './product-loading';

function Breadcrumbs({
  categories,
  id,
  name,
  hidden = false,
}: {
  hidden?: boolean;
  categories: Category[];
  id?: string;
  name?: string;
}) {
  const { t: ui } = useInterface();
  const ancestors: Category[] = [];
  let c = categories.find((c) => c.id === id);
  while (c && !ancestors.some((a) => a.id === c?.id)) {
    ancestors.unshift(c);
    c = categories.find((a) => a.id === c?.parent_id);
  }
  return (
    <nav className="breadcrumbs" aria-label={ui("storefront.breadcrumb", "Breadcrumb")} hidden={hidden}>
      <Link to="/">{ui("navigation.home", "Home")}</Link>
      {ancestors.map((c) => (
        <span key={c.id}>
          / <Link to={`/categories/${c.id}`}>{c.name}</Link>
        </span>
      ))}
      {name && <span>/ {name}</span>}
    </nav>
  );
}
export function Browse({ home = false, customer }: { home?: boolean; customer?: Customer | null }) {
  const { message } = useInterface();
  const { t: ui, locale } = useInterface();
  const theme = useTheme();
  const showcase = theme.global.top.some(s => s.enabled && s.component === "presentation" && s.settings.style === "showcase");

  const CollectionHeading = home ? 'h2' : 'h1';
  const delivery=useDeliveryKey();
  const { id } = useParams();
  const filterLayout = theme.pages[id ? "category" : "search"].find(s => s.enabled && s.component === "catalog_filters")?.settings.layout || theme.global.top.find(s => s.enabled && s.component === "catalog_filters")?.settings.layout || "vertical";
  const [params, setParams] = useSearchParams();
  const cats = useQuery({
    queryKey: ["categories", locale],
    queryFn: () => catalogApi.categories(locale),
  });
  const visibleCategories = shopperCategories(cats.data ?? []);
  const categoryReferences = browseCategoryReferences(params);
  const categoryReference = id || categoryReferences[0] || undefined;
  const selectedCategories = categoryReferences.map(reference => resolveBrowseCategory(cats.data ?? [], reference));
  const selectedCategoryIds = [...new Set(selectedCategories.flatMap(category => category ? [category.id] : []))];
  const categoryIds = !id && selectedCategoryIds.length > 1 ? selectedCategoryIds.join(',') : undefined;
  const selectedCategory = resolveBrowseCategory(cats.data ?? [], categoryReference);
  const category = id ? selectedCategory : undefined;
  const attributeFilters = params.get("attributes") || undefined;
  const input = useMemo<SearchInput>(
    () => ({
      q: params.get("q") ?? "",
      category_id: categoryIds ? undefined : selectedCategory?.id,
      category_ids: categoryIds,
      min_price: params.get("min") || undefined,
      max_price: params.get("max") || undefined,
      in_stock: params.get("stock") === "true" ? true : undefined,
      attribute_filters: attributeFilters,
      sort_by: params.get("sort_by") || undefined,
      sort_order: params.get("sort_order") === "desc" ? "desc" : "asc",
      offset: Number(params.get("offset") ?? 0),
    }),
    [params, selectedCategory?.id, categoryIds, attributeFilters],
  );
  const q = useQuery({
    queryKey: ["catalog-search", input, delivery, id, categoryReferences, locale],
    enabled: !categoryReference || cats.isSuccess,
    queryFn: () => {
      if ((categoryReference && !selectedCategory) || (!id && selectedCategories.some(category => !category))) throw new Error(ui("storefront.category_not_found", "Category not found"));
      return catalogApi.search(input, undefined, locale);
    },
    refetchInterval: 5000,
    placeholderData: previous => previous,
  });
  const last = useRef("");
  useEffect(() => {
    const key = JSON.stringify(input);
    if (q.data && last.current !== key) {
      last.current = key;
      track(
        "search_query",
        id ? `/categories/${id}` : home ? "/" : "/search",
        input.q ?? "",
        q.data.total,
      );
    }
  }, [q.data, input, id, home]);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [collapsedFilters, setCollapsedFilters] = useState<Record<string, boolean>>({});
  const filterTimer = useRef<ReturnType<typeof setTimeout>>();
  const filterFocus = useRef<string>();
  const draggingPrice = useRef(false);
  useEffect(() => {
    if (filterFocus.current) {
      document.querySelector<HTMLFormElement>('.live-filters')?.querySelectorAll<HTMLInputElement>('input, select').forEach(el => {
        if ((el.getAttribute('aria-label') || el.name) === filterFocus.current) el.focus();
      });
      filterFocus.current = undefined;
    }
  }, [params]);
  const shoppingKey=shoppingLocationKey(id ?? "", params.toString());
  useEffect(() => () => clearTimeout(filterTimer.current), [shoppingKey]);
  function filter(form: HTMLFormElement, sort?: string) {
    clearTimeout(filterTimer.current);
    if (!form.checkValidity()) return;
    const focused = document.activeElement as HTMLInputElement | null;
    filterFocus.current = focused && form.contains(focused) ? focused.getAttribute('aria-label') || focused.name : undefined;
    const data = new FormData(form);
    const next = id ? new URLSearchParams(params) : replaceBrowseCategories(params, data.getAll("category").map(String));
    ["min", "max", "stock"].forEach((k) => {
      const v = data.get(k)?.toString();
      if (v) next.set(k, v);
      else next.delete(k);
    });
    const attributes = attributeFiltersFromForm(data);
    if(Object.keys(attributes).length) next.set("attributes",JSON.stringify(attributes));else next.delete("attributes");
    if (sort !== undefined) {
      const [by, order] = sort.split(':');
      if (by) { next.set('sort_by', by); next.set('sort_order', order); }
      else { next.delete('sort_by'); next.delete('sort_order'); }
    }
    next.delete("offset");
    if (next.toString() !== params.toString()) setParams(next);
  }
  function page(offset: number) {
    const next = new URLSearchParams(params);
    next.set("offset", String(offset));
    setParams(next);
  }
  return (
    <main className="browse-main">
      {home && (
        <ManagedContent
          name="home"
          fallback={
            <section className="grocery-hero">
              <div>
                <p className="eyebrow">{ui("catalog.good_food", "GOOD FOOD. EVERY DAY.")}</p>
                <h1>
                  {ui("catalog.fresh_finds", "Fresh finds.")} <br />
                  {ui("catalog.everyday_favorites", "Everyday favorites.")} </h1>
                <p>
                  {ui("catalog.fruit_pantry", "From the fruit bowl to the pantry.")} <br />
                  {ui("catalog.simple_things", "Find the simple things that make your day.")} </p>
                <Link to="/search" className="primary-link">
                  {ui("catalog.explore_shelves", "Explore the shelves")} <span>↗</span>
                </Link>
              </div>
              <div className="hero-art" aria-hidden="true">
                <svg viewBox="0 0 420 320">
                  <ellipse cx="205" cy="278" rx="157" ry="18" fill="#c4cfb7" />
                  <path d="M97 137h229l-22 137H119z" fill="#a8b792" />
                  <path
                    d="M121 160h181M125 191h173M129 223h165M149 140v130m49-130v134m49-134v134m47-134v124"
                    stroke="#e9eddf"
                    strokeWidth="9"
                  />
                  <ellipse cx="123" cy="117" rx="49" ry="39" fill="#e9ac51" />
                  <ellipse cx="238" cy="103" rx="39" ry="47" fill="#bd5540" />
                  <path d="M235 64q2-33 30-34-4 24-30 34" fill="#376a47" />
                  <path
                    d="M156 127q-23-82 0-88 29-10 47 66 10 44-47 22"
                    fill="#6b8d52"
                  />
                  <path d="M284 134q8-100 42-99 20 15-15 106" fill="#e8c775" />
                  <path d="M270 128q-29-53 3-57 28-1 25 61" fill="#d58b49" />
                  <path
                    d="M85 139h248"
                    stroke="#526b44"
                    strokeWidth="12"
                    strokeLinecap="round"
                  />
                  <path
                    d="M122 140q13-102 89-98 75 4 83 98"
                    fill="none"
                    stroke="#526b44"
                    strokeWidth="9"
                  />
                </svg>
                <span className="hero-note">
                  {ui("catalog.little_goodness", "A little goodness")} <br />
                  {ui("catalog.every_basket", "in every basket.")} </span>
              </div>
            </section>
          }
        />
      )}
      {!home && (
        <Breadcrumbs
          hidden
          categories={cats.data ?? []}
          id={category?.id}
          name={id ? undefined : ui("storefront.shop_all","Shop all")}
        />
      )}
      {!home && category?.banner && (
        <div className="category-banner">
          <StorefrontImage id={category.banner} metadata={category.images?.[category.banner]} alt={ui("product.banner", "{name} banner", {name:category.name})} sizes="100vw" fetchPriority="high" />
        </div>
      )}
      {showcase && !home && <section className="tech-category-intro" aria-label={ui("catalog.explore_electronics", "Explore electronics")}>
        <div><p className="eyebrow">{ui("catalog.tech_life", "TECH THAT FITS YOUR LIFE")}</p><h2>{category ? ui("catalog.category_favorite", "Find your next favorite in {category}.", {category:category.name.toLowerCase()}) : ui("catalog.smarter_day", "A smarter everyday starts here.")}</h2><p>{ui("catalog.tech_intro", "Explore phones, laptops, audio and home essentials. Find the details that make the difference.")}</p></div>
        <Link to="/assistant">{ui("storefront.help_me_choose", "Help me choose")} <span aria-hidden="true">↗</span></Link>
      </section>}
      {showcase && !home && <nav className="tech-category-links" aria-label={ui("catalog.tech_categories", "Browse electronics categories")}>{visibleCategories.filter(c => !c.parent_id).map(c => <Link key={c.id} to={`/categories/${c.id}`} aria-current={category?.id === c.id ? "page" : undefined}>{c.thumbnail && <StorefrontImage id={c.thumbnail} metadata={c.images?.[c.thumbnail]} alt="" sizes="48px" loading="lazy" />}<span>{c.name}</span></Link>)}</nav>}
      {!id && <div className="collection-title">
        <div>
          <p className="eyebrow">
            {home ? ui("catalog.explore", "EXPLORE THE CATALOG") : ui("catalog.collection", "EXPLORE OUR COLLECTION")}
          </p>
          <CollectionHeading>
            {category?.name ??
              (input.q
                ? ui("search.results_for", "Results for \u201c{query}\u201d", {query:input.q})
                : home
                  ? ui("catalog.explore_products", "Explore our products")
                  : ui("storefront.shop_all", "Shop all"))}
          </CollectionHeading>
        </div>
        <span>
          {q.data
            ? ui("search.product_count", q.data.total===1?"{count} product":"{count} products", {count:q.data.total})
            : ""}
        </span>
      </div>}
      {id && (
        <div className="subcategories">
          {visibleCategories
            ?.filter((c) => c.parent_id === category?.id)
            .map((c) => (
              <Link key={c.id} to={`/categories/${c.id}`}>
                {c.thumbnail && <StorefrontImage className="category-thumbnail" id={c.thumbnail} metadata={c.images?.[c.thumbnail]} alt="" sizes="36px" loading="lazy" />}
                {c.name} ↗
              </Link>
            ))}
        </div>
      )}
      <div className="catalog-layout" data-filter-layout={String(filterLayout)}>
        <aside className={filtersOpen ? 'catalog-filter-sidebar is-open' : 'catalog-filter-sidebar'}>
          <button className="mobile-filter-toggle" aria-expanded={filtersOpen} aria-controls="catalog-filters" onClick={() => setFiltersOpen(open => !open)}>{filtersOpen ? ui("storefront.hide_filters", "Hide filters") : ui("storefront.show_filters", "Show filters")}</button>
          <form id="catalog-filters"
            key={shoppingLocationKey(id ?? "", params.toString())}
            className="filters live-filters"
            aria-label={ui("storefront.product_filters", "Product filters")}
            onSubmit={e => { e.preventDefault(); filter(e.currentTarget); }}
            onPointerDown={e => { if ((e.target as HTMLInputElement).type === 'range') { draggingPrice.current = true; clearTimeout(filterTimer.current); } }}
            onPointerUp={e => { if (draggingPrice.current) { draggingPrice.current = false; filter(e.currentTarget); } }}
            onPointerCancel={() => { draggingPrice.current = false; }}
            onChange={e => {
              const form = e.currentTarget;
              clearTimeout(filterTimer.current);
              if (!draggingPrice.current) filterTimer.current = setTimeout(() => filter(form), 350);
            }}
          >
            <div className="filter-heading"><h3>{ui("storefront.filter_products", "Filter products")}</h3><span>{ui("storefront.updates_automatically", "Updates automatically")}</span></div>
            {!id && (
              <fieldset className="category-checkbox-filter">
                <legend>{ui("storefront.category", "Category")}</legend>
                {!selectedCategoryIds.length && <small>{ui("storefront.all_categories", "All categories")}</small>}
                <div className="category-checkbox-options">
                  {visibleCategories.map(c => (
                    <label key={c.id} className="checkbox" data-nested={!!c.parent_id}>
                      <input type="checkbox" name="category" value={c.id} aria-label={c.name} defaultChecked={selectedCategoryIds.includes(c.id)} />
                      <span>{c.name}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            <PriceFilter min={input.min_price} max={input.max_price}/>
            <label className="checkbox">
              <input
                name="stock"
                type="checkbox"
                value="true"
                defaultChecked={input.in_stock}
              />
              {ui("storefront.in_stock_only", "In stock only")} </label>
            <CustomFilters params={params} facets={q.isPlaceholderData ? undefined : q.data?.facets} collapsed={collapsedFilters} defaultCollapsed={filterLayout === "horizontal"}
              onToggle={(code, closed) => setCollapsedFilters(previous => previous[code] === closed ? previous : {...previous,[code]:closed})}
              onRemove={(code, value) => { clearTimeout(filterTimer.current); setParams(removeAttributeFilter(params,code,value)); }} />
            <button
              type="button"
              className="text-button"
              onClick={() => { clearTimeout(filterTimer.current); setParams(input.q ? { q: input.q } : {}); }}
            >
              {ui("storefront.reset_all_filters", "Reset all filters")} </button>
          </form>
        </aside>
        <section aria-label={ui("storefront.products", "Products")} aria-busy={q.isFetching}>
          <div className="catalog-results-toolbar">{id ? <h1 className="catalog-category-heading">{category?.name || ui("storefront.all_products", "All products")}</h1> : <strong>{ui("storefront.all_products", "All products")}</strong>}<ProductSort value={input.sort_by ? `${input.sort_by}:${input.sort_order}` : ""} onChange={value => {
            clearTimeout(filterTimer.current);
            const form = document.querySelector<HTMLFormElement>('#catalog-filters');
            if (form) filter(form, value);
          }}/></div>
          <p className="sr-only" role="status" aria-live="polite">{q.isFetching ? ui("storefront.updating_products", "Updating products…") : q.data ? ui("search.products_found", q.data.total===1?"{count} product found":"{count} products found", {count:q.data.total}) : ""}</p>
          <Notice error>{message((q.error?.message || cats.error?.message) || '')}</Notice>
          {q.isPending && <p role="status">{ui("storefront.finding_your_favorites", "Finding your favorites…")}</p>}
          {q.data?.hits.length === 0 && (
            <div className="empty-catalog">
              <h3>{ui("search.no_results", "No products found")}</h3>
              <p>{ui("storefront.try_another_search_or_widen_your_filters", "Try another search or widen your filters.")}</p>
            </div>
          )}
          <div className="product-grid">
            {q.data?.hits.map((p) => (
              <ProductCard key={p.id} product={p} customer={customer} />
            ))}
          </div>
          {q.data && (q.data.offset > 0 || q.data.total > 24) && (
            <div className="pagination">
              <button
                className="secondary"
                disabled={!q.data.offset}
                onClick={() => page(Math.max(0, q.data!.offset - 24))}
              >
                {ui("storefront.previous", "Previous")} </button>
              <span>{ui("storefront.page", "Page")} {Math.floor(q.data.offset / 24) + 1}</span>
              <button
                className="secondary"
                disabled={q.data.offset + 24 >= q.data.total}
                onClick={() => page(q.data!.offset + 24)}
              >
                {ui("storefront.next", "Next")} </button>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
export function ProductDetail({ customer }: { customer: Customer | null }) {
  const { message } = useInterface();
  const { t: ui, locale } = useInterface();
  const navigationType = useNavigationType();
  const { pathname } = useLocation();
  useLayoutEffect(() => {
    // Reset before paint so a product opened from a scrolled list starts at the top.
    // Leave browser Back/Forward navigation to native scroll restoration.
    if (navigationType !== "POP") {
      window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    }
  }, [pathname, navigationType]);
  const theme = useTheme();
  const showcase = theme.global.top.some(s => s.enabled && s.component === "presentation" && s.settings.style === "showcase");
  const heritage = theme.global.top.some(s => s.enabled && s.component === 'presentation' && s.settings.style === 'heritage');
  const delivery=useDeliveryKey();
  const { id } = useParams();
  const q = useQuery(productQuery(id!, delivery, customer?.id, locale));
  const cats = useQuery({
    queryKey: ["categories", locale],
    queryFn: () => catalogApi.categories(locale),
  });
  const [selected, setSelected] = useState(0);
  useEffect(() => setSelected(0), [id]);
  const p = q.data;
  const media = useQuery({
    queryKey: ["media", p?.media_ids[selected]],
    queryFn: () => catalogApi.media(p!.media_ids[selected]),
    enabled: !!p?.media_ids[selected],
  });
  return (
    <main className={`product-main${!heritage && !showcase ? " product-main-grocery" : ""}`}>
      <Notice error>{message((q.error?.message) || '')}</Notice>
      {q.isPending && <ProductLoading contentOnly />}
      {p && (
        <>
          {!heritage && (<Breadcrumbs
            categories={cats.data ?? []}
            id={p.category_id}
            name={p.name}
          />)}
          <div className={`product-detail${heritage ? "" : " product-detail-grocery"}`}>
            <section className="product-media-panel" aria-label={ui("storefront.product_gallery", "Product gallery")}>
              <div className="detail-image">
                {p.media_ids[selected] ? (
                  <StorefrontImage
                    id={p.media_ids[selected]}
                    metadata={p.images?.[p.media_ids[selected]]}
                    alt={media.data?.alt ?? p.name}
                    width={800} height={800} sizes={productDetailImageSizes} fetchPriority="high"
                  />
                ) : (
                  <span className="product-placeholder">❧</span>
                )}
              </div>
              <div className="thumbnails">
                {p.media_ids.map((id, i) => (
                  <button
                    key={id}
                    className={selected === i ? "selected" : "secondary"}
                    onClick={() => setSelected(i)}
                    aria-label={ui("product.view_image", "View image {count}", {count:i+1})}
                    aria-pressed={selected === i}
                  >
                    <StorefrontImage id={id} metadata={p.images?.[id]} alt="" sizes="60px" width={60} height={60} />
                  </button>
                ))}
              </div>
            </section>
            {heritage ? <section className="buy-box">
              <Breadcrumbs categories={cats.data ?? []} id={p.category_id} name={p.name} />
              <p className="product-collection">{String(p.attributes.collection || cats.data?.find(c => c.id === p.category_id)?.name || "")}</p>
              <p className="eyebrow">{ui("catalog.everyday_goodness", "EVERYDAY GOODNESS")}</p><h1>{p.name}</h1><CompareButton id={p.id} name={p.name} />
              <p className="detail-price">{p.product_type === "simple" ? <CatalogPrice product={p}/> : ui("storefront.choose_your_items_below", "Choose your items below")}</p>
              <p className="product-description">{p.description}</p>
              {p.product_type === "simple" ? <AddToCart key={p.id} id={p.id} productName={p.name} purchasePanel /> : <ProductOptions key={p.id} product={p}/>}<WishButton id={p.id} customer={customer} />
              <div className="product-information">
                <details open><summary>{ui("storefront.technical_description", "Technical description")}</summary><div className="product-information-body">
                  <p className="product-description">{p.description}</p>
                  <dl className="product-attributes"><div><dt>SKU</dt><dd>{p.sku}</dd></div><DisplayAttributes product={p}/></dl>
                </div></details>
                <details><summary>{ui("storefront.customer_care", "Customer care")}</summary><div className="product-information-body"><p>{ui("storefront.need_help_choosing_your_piece_or_finding_the_right_size", "Need help choosing your piece or finding the right size?")}</p><Link to="/assistant">{ui("storefront.ask_our_assistant", "Ask our assistant")}</Link><Link to="/support">{ui("storefront.contact_customer_care", "Contact customer care")}</Link></div></details>
              </div>
            </section> : <>
              <section className="product-summary">
                {showcase && <p className="tech-product-brand">{String(p.attributes.brand || "Rocento Tech")}</p>}
                <p className="eyebrow">{String(cats.data?.find(c => c.id === p.category_id)?.name || (showcase ? ui("catalog.electronics", "ELECTRONICS") : ui("catalog.grocery", "GROCERY")))}</p>
                <h1>{p.name}</h1><CompareButton id={p.id} name={p.name} />
                <p className="product-summary-unit">{p.product_type === "simple" ? `${showcase ? ui("storefront.model", "Model") : p.unit} · ${p.sku}` : ui("storefront.select_the_option_that_suits_you", "Select the option that suits you")}</p>
                {showcase && <nav className="tech-detail-links" aria-label={ui("storefront.product_information", "Product information")}><a href="#tech-specifications">{ui("storefront.specifications", "Specifications")}</a><a href="#customer-reviews">{ui("storefront.customer_reviews", "Customer reviews")}</a></nav>}
                <div className="product-overview">
                  <h2>{ui("storefront.product_overview", "Product overview")}</h2>
                  <p className="product-description">{p.description}</p>
                  {!showcase && <dl className="product-attributes"><div><dt>SKU</dt><dd>{p.sku}</dd></div><DisplayAttributes product={p}/></dl>}
                </div>
                {showcase && <div className="tech-shopping-help"><strong>{ui("storefront.find_your_perfect_fit", "Find your perfect fit")}</strong><p>{ui("storefront.ask_about_features_compare_your_options_or_get_help_choosing", "Ask about features, compare your options, or get help choosing.")}</p><Link to="/assistant">{ui("storefront.ask_the_shopping_assistant", "Ask the shopping assistant ↗")}</Link></div>}
              </section>
              <aside className="purchase-panel" aria-label={ui("storefront.purchase_options", "Purchase options")}>
                <div className="purchase-card purchase-card-refined">
                  {showcase && <span className="tech-availability">{p.in_stock ? ui("storefront.available_to_order", "Available to order") : ui("storefront.check_availability_for_your_area", "Check availability for your area")}</span>}
                  <span className="purchase-label">{showcase ? ui("storefront.pay_in_full", "Pay in full") : ui("storefront.price", "Price")}</span>
                  <p className="detail-price">{p.product_type === "simple" ? <CatalogPrice product={p} showUnit={!showcase}/> : ui("storefront.choose_your_items_below", "Choose your items below")}</p>
                  {p.product_type === "simple" ? <AddToCart key={p.id} id={p.id} productName={p.name} purchasePanel /> : <ProductOptions key={p.id} product={p}/>} 
                  <WishButton id={p.id} customer={customer} />
                </div>
                <PurchaseAssurance kind="delivery" title={ui("storefront.delivery_availability_2", "Delivery & availability")}><p>{ui("storefront.set_your_delivery_location_to_see_availability_for_your_area", "Set your delivery location to see availability for your area.")}</p><Link to="/delivery-location">{ui("storefront.set_delivery_location", "Set delivery location")} <span className="direction-icon" aria-hidden="true">→</span></Link></PurchaseAssurance>
                <PurchaseAssurance kind="secure" title={ui("checkout.secure", "Secure checkout")}><p>{ui("storefront.review_your_items_and_final_total_before_placing_your_order", "Review your items and final total before placing your order.")}</p></PurchaseAssurance>
              </aside>
            </>}
          </div>
          {showcase && <section id="tech-specifications" className="tech-specifications"><p className="eyebrow">{ui("storefront.the_details", "THE DETAILS")}</p><h2>{ui("storefront.technical_specifications", "Technical specifications")}</h2><dl className="product-attributes"><div><dt>{ui("storefront.model_sku", "Model / SKU")}</dt><dd>{p.sku}</dd></div><DisplayAttributes product={p}/></dl><p className="tech-demo-note">{ui("catalog.demo_disclaimer", "Illustrative demo products. Specifications and prices are sample data.")}</p></section>}
          <ProductRelationships sources={[p.id]} kind="related" customer={customer}/>
          <ProductRelationships sources={[p.id]} kind="upsell" customer={customer}/>
          <div id="customer-reviews" className="product-reviews">
            <ProductReviews id={p.id} customer={customer} />
          </div>
        </>
      )}
    </main>
  );
}
