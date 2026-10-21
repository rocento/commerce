import { useInterface } from '../interface-locale';
import { ProductPrice } from "../product-price";
import type { PublicSnapshot } from './types';
import { PublicationImage } from './image';
export function MerchantIdentity({ snapshot: s }: { snapshot: PublicSnapshot }) {
  const {t: ui}=useInterface();
  const m = s.merchant; if (!m) return null;
  return <section className="theme-section" id="merchant" aria-label={ui("public.merchant_information", "Merchant information")}><h2>{ui("public.about_brand", "About {brand}", {brand:s.site_name})}</h2>
    {m.logo_id && s.images[m.logo_id] && <PublicationImage id={m.logo_id} alt={`${s.site_name} logo`} style={{ maxWidth: 160 }} />}
    {m.legal_name && <p>{ui("public.business_name", "Business name:")}{" "}{m.legal_name}</p>}<p>{m.description}</p>
    {(m.country || m.region) && <p>{[m.region, m.country].filter(Boolean).join(', ')}</p>}
    {m.locations.length > 0 && <div><h3>{ui("public.public_locations", "Public locations")}</h3>{m.locations.map(v => <address key={v}>{v}</address>)}</div>}
    {(m.email || m.telephone) && <section id="customer-service"><h3>{ui("public.customer_service", "Customer service")}</h3>{m.email && <p>{m.email}</p>}{m.telephone && <p>{m.telephone}</p>}</section>}
    {m.delivery_areas.length > 0 && <section id="delivery-areas"><h3>{ui("public.delivery_areas", "Delivery areas")}</h3><p>{m.delivery_areas.join(', ')}</p><p>{ui("public.availability_and_final_delivery_terms_depend_on_your_selected_location_and_items", "Availability and final delivery terms depend on your selected location and items.")}</p></section>}
    {m.pages.length > 0 && <nav aria-label={ui("public.merchant_policies_and_guides", "Merchant policies and guides")}><h3>{ui("public.policies_and_guides", "Policies and guides")}</h3><ul>{m.pages.map(p => <li key={p.document_id}><a href={p.url}>{p.title}</a>{p.effective_date && <>{ui("public.effective", "— effective")}{" "}<time dateTime={p.effective_date}>{p.effective_date}</time></>}</li>)}</ul></nav>}
    {m.social_profiles.length > 0 && <nav aria-label={ui("public.merchant_social_profiles", "Merchant social profiles")}>{m.social_profiles.map(url => <p key={url}><a href={url} rel="me noreferrer">{new URL(url).hostname}</a></p>)}</nav>}
  </section>;
}
export function ContentContext({ snapshot: s }: { snapshot: PublicSnapshot }) {
  const {t: ui}=useInterface();
  if (!s.content) return null;
  const page = s.merchant?.pages.find(p => p.document_id === s.content?.id);
  return <div><p>{ui("public.published_by", "Published by")}{" "}<span>{s.site_name}</span> {s.content.updated_at && <>{ui("public.content_updated", "· Content updated")}{" "}<time dateTime={s.content.updated_at}>{s.content.updated_at.slice(0, 10)}</time></>}</p>{page?.effective_date && <p>{ui("public.effective_from", "Effective from")}{" "}<time dateTime={page.effective_date}>{page.effective_date}</time></p>}</div>;
}
export function Comparison({ snapshot: s }: { snapshot: PublicSnapshot }) {
  const {t: ui}=useInterface();
  const products = s.comparisons || []; if (products.length < 2) return null;
  const labels = [...new Set(products.flatMap(p => Object.keys(p.attributes)))];
  return <section id="product-comparison"><h2>{ui("public.catalog_comparison", "Catalog comparison")}</h2><p>{ui("public.current_public_catalog_facts_missing_specifications_are_not_inferred", "Current public catalog facts. Missing specifications are not inferred.")}{" "}{s.availability}</p><div style={{ overflowX: 'auto' }}><table><caption>{ui("public.products_sold_by_brand", "Products sold by {brand}", {brand:s.site_name})}</caption><thead><tr><th scope="col">{ui("public.fact", "Fact")}</th>{products.map(p => <th scope="col" key={p.id}><a href={`/products/${p.slug}`}>{p.name}</a></th>)}</tr></thead><tbody>
    <tr><th scope="row">{ui("public.public_price", "Public price")}</th>{products.map(p => <td key={p.id}>{p.product_type === 'simple' ? <ProductPrice price={p.price} originalPrice={p.original_price} currency={p.currency} unit={p.unit}/> : ui("public.choose_options_for_pricing", "Choose options for pricing")}</td>)}</tr>
    {labels.map(label => <tr key={label} id={`comparison-${encodeURIComponent(label)}`}><th scope="row">{label}</th>{products.map(p => <td key={p.id}>{p.attributes[label] === undefined ? ui("public.not_provided", "Not provided") : String(p.attributes[label])}</td>)}</tr>)}
  </tbody></table></div></section>;
}
