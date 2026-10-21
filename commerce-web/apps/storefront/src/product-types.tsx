import { attributeFilterOptions, readAttributeFilters, selectedAttributeValues, type AttributeFacets } from "./attribute-filters";
import { useInterface } from './interface-locale';
import { CatalogPrice } from "./product-price";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { attributeApi, cartApi, type Product } from "@commerce/api-client";
import { Notice, useAction, AttributeFields, Field } from "@commerce/ui";
import { AddToCart } from "./cart";
import { useDeliveryKey } from "./locations";
export function ProductOptions({ product }: { product: Product }) {
  const { message } = useInterface();
  const { t: ui, locale } = useInterface();
  const delivery = useDeliveryKey();
  const q = useQuery({
    queryKey: ["product-family", product.id, delivery, locale],
    queryFn: () => attributeApi.family(product.id, locale),
    refetchInterval: 5000,
  });
  const [variant, setVariant] = useState(""),
    [choices, setChoices] = useState<Record<string, string>>({}),
    a = useAction(),
    cache = useQueryClient();
  const defs = useQuery({
    queryKey: ["public-attributes", locale],
    queryFn: () => attributeApi.public(locale),
  });
  const data = q.data;
  if (!data)
    return (
      <Notice error>{message((q.error?.message || ui("product.loading_choices", "Loading product choices…")) || '')}</Notice>
    );
  const label = (p: Product) =>
    data.structure.configurable_attributes
      .map((code) => {
        const v = p.variant_attributes[code];
        return (
          defs.data
            ?.find((d) => d.attribute_code === code)
            ?.options.find((o) => o.value === v)?.label ?? String(v)
        );
      })
      .join(" / ");
  const selected = data.children.find((p) => p.id === variant);
  if (product.product_type === "configurable")
    return (
      <section>
        <label className="field">
          {ui("product.choose_variant", "Choose variant")} <select value={variant} onChange={(e) => setVariant(e.target.value)}>
            <option value="">{ui("product.choose_option", "Choose an option")}</option>
            {data.children.map((p) => (
              <option key={p.id} value={p.id}>
                {label(p)} — {p.price} {p.currency}
                {!p.in_stock ? " · " + ui("product.out_of_stock", "Out of stock") : ""}
              </option>
            ))}
          </select>
        </label>
        {selected && (
          <>
            <h2>{label(selected)}</h2>
            <p>
              <CatalogPrice product={selected}/> · {selected.sku}
            </p>
            <AddToCart key={selected.id} id={selected.id} />
          </>
        )}
        {!data.children.length && <p>{ui("product.no_variants", "No available variants.")}</p>}
      </section>
    );
  if (product.product_type === "grouped")
    return (
      <section>
        <h2>{ui("product.essentials", "Choose your essentials")}</h2>
        {data.children.map((p) => (
          <article className="form-card" key={p.id}>
            <h3>{p.name}</h3>
            <p>
              <CatalogPrice product={p}/>
            </p>
            <AddToCart id={p.id} />
          </article>
        ))}
      </section>
    );
  const groups = [
    ...new Set(data.structure.children.map((l) => l.option_label)),
  ];
  const total = groups.reduce((sum, g) => {
    const id = choices[g],
      p = data.children.find((p) => p.id === id),
      link = data.structure.children.find((l) => l.child_id === id);
    return (
      sum + (p && link ? Math.round(Number(p.price) * 100) * link.quantity : 0)
    );
  }, 0);
  return (
    <section>
      <h2>{ui("product.build_basket", "Build your basket")}</h2>
      <p>
        {ui("product.basket_help", "Choose one item per group. Items are priced and fulfilled individually; all choices are added together.")} </p>
      {groups.map((g) => (
        <label className="field" key={g}>
          {g}
          <select
            value={choices[g] ?? ""}
            onChange={(e) => setChoices({ ...choices, [g]: e.target.value })}
          >
            <option value="">{ui("product.choose_item", "Choose an item")}</option>
            {data.structure.children
              .filter((l) => l.option_label === g)
              .map((l) => {
                const p = data.children.find((p) => p.id === l.child_id);
                return (
                  p && (
                    <option key={p.id} value={p.id}>
                      {p.name} × {l.quantity} — $
                      {(Number(p.price) * l.quantity).toFixed(2)}
                      {!p.in_stock ? " · " + ui("product.out_of_stock", "Out of stock") : ""}
                    </option>
                  )
                );
              })}
          </select>
        </label>
      ))}
      <p>{ui("product.selected_total", "Selected items: {total}", {total:"$"+(total/100).toFixed(2)})}</p>
      <Notice error>{message((a.error) || '')}</Notice>
      <Notice>{message((a.message) || '')}</Notice>
      <button
        disabled={a.busy || groups.some((g) => !choices[g])}
        onClick={() =>
          a.run(async () => {
            await cartApi.open();
            await attributeApi.bundle(
              product.id,
              groups.map((g) => choices[g]),
            );
            await cache.invalidateQueries({ queryKey: ["cart"] });
            a.setMessage("Your basket items were added to the cart.");
          })
        }
      >
        {ui("product.add_basket", "Add basket to cart")} </button>
    </section>
  );
}
export function ProfileEditor({ customerId }: { customerId: string }) {
  const { message } = useInterface();
  const { t: ui, locale } = useInterface();
  const q = useQuery({
      queryKey: ["extended-profile", customerId],
      queryFn: attributeApi.profile,
    }),
    defs = useQuery({
      queryKey: ["customer-attributes", customerId, locale],
      queryFn: () => attributeApi.customerDefinitions(locale),
    });
  const [form, setForm] =
      useState<Awaited<ReturnType<typeof attributeApi.profile>>>(),
    a = useAction();
  const v = form ?? q.data;
  return (
    <section className="form-card">
      <h2>{ui("account.personal_details", "Personal details")}</h2>
      <Notice error>
        {message((q.error?.message || defs.error?.message || a.error) || '')}
      </Notice>
      <Notice>{message((a.message) || '')}</Notice>
      {v && (
        <form
          className="personal-details-form"
          onSubmit={(e) => {
            e.preventDefault();
            void a.run(async () => {
              await attributeApi.saveProfile({
                first_name: v.first_name,
                last_name: v.last_name,
                date_of_birth: v.date_of_birth,
                gender: v.gender,
                attributes: v.attributes,
              });
              a.setMessage("Your details were saved.");
            });
          }}
        >
          <Field
            label={ui("account.first_name", "First name")}
            value={v.first_name}
            onChange={(e) => setForm({ ...v, first_name: e.target.value })}
          />
          <Field
            label={ui("account.last_name", "Last name")}
            value={v.last_name}
            onChange={(e) => setForm({ ...v, last_name: e.target.value })}
          />
          <Field
            label={ui("account.date_of_birth", "Date of birth")}
            type="date"
            value={v.date_of_birth ?? ""}
            onChange={(e) =>
              setForm({ ...v, date_of_birth: e.target.value || null })
            }
          />
          <label className="field">{ui("account.gender", "Gender")}<select
              value={v.gender}
              onChange={(e) => {
                const gender = e.currentTarget.value;
                if (gender === "" || gender === "female" || gender === "male" ||
                    gender === "other" || gender === "prefer_not_to_say") {
                  setForm({ ...v, gender });
                }
              }}
            >
              <option value="">{ui("account.not_set", "Not set")}</option>
              <option value="female">{ui("account.female", "Female")}</option>
              <option value="male">{ui("account.male", "Male")}</option>
              <option value="other">{ui("storefront.other", "Other")}</option>
              <option value="prefer_not_to_say">{ui("account.prefer_not_to_say", "Prefer not to say")}</option>
            </select>
          </label>
          <AttributeFields
            definitions={defs.data ?? []}
            values={v.attributes}
            onChange={(attributes) => setForm({ ...v, attributes })}
          />
          <button disabled={a.busy}>{ui("account.save_personal_details", "Save personal details")}</button>
        </form>
      )}
    </section>
  );
}
export function ProductSort({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { t: ui, locale } = useInterface();
  const q = useQuery({ queryKey: ["public-attributes", locale], queryFn: () => attributeApi.public(locale), refetchInterval: 5000 });
  const attributes = q.data?.filter(d => d.is_visible_on_front && d.metadata?.status !== 'disabled' && d.metadata?.sortable && !['price', 'name'].includes(d.attribute_code)) ?? [];
  return <label className="product-sort"><span>{ui("search.sort", "Sort by")}</span><select aria-label={ui("search.sort_products", "Sort products")} value={value} onChange={e => onChange(e.target.value)}>
    <option value="">{ui("search.recommended", "Recommended")}</option>
    <option value="price:asc">{ui("search.price_asc", "Price: low to high")}</option>
    <option value="price:desc">{ui("search.price_desc", "Price: high to low")}</option>
    <option value="name:asc">{ui("search.name_asc", "Name: A to Z")}</option>
    <option value="name:desc">{ui("search.name_desc", "Name: Z to A")}</option>
    {attributes.flatMap(d => [<option key={d.attribute_code + ':asc'} value={d.attribute_code + ':asc'}>{ui("search.attribute_asc", "{attribute}: ascending", {attribute:d.label})}</option>, <option key={d.attribute_code + ':desc'} value={d.attribute_code + ':desc'}>{ui("search.attribute_desc", "{attribute}: descending", {attribute:d.label})}</option>])}
  </select></label>;
}
export function CustomFilters({ params, facets, collapsed, defaultCollapsed = false, onToggle, onRemove }: {
  params: URLSearchParams;
  facets?: AttributeFacets;
  collapsed: Record<string, boolean>;
  defaultCollapsed?: boolean;
  onToggle: (code: string, closed: boolean) => void;
  onRemove: (code: string, value: string) => void;
}) {
  const { message, t: ui, locale } = useInterface();
  const q = useQuery({queryKey:["public-attributes",locale],queryFn:()=>attributeApi.public(locale),refetchInterval:5000});
  const values = readAttributeFilters(params);
  const definitions = q.data?.filter(d => d.is_filterable && d.is_visible_on_front && d.metadata?.status !== "disabled")
    .sort((a,b) => (a.metadata?.display_order ?? 0) - (b.metadata?.display_order ?? 0)) ?? [];
  const active = definitions.flatMap(d => selectedAttributeValues(values[d.attribute_code]).map(value => ({
    code:d.attribute_code, value, label:d.label,
    option:d.input_type === "boolean" ? value === "true" ? ui("common.yes","Yes") : ui("common.no","No") : d.options.find(o => o.value === value)?.label ?? value,
  })));
  return <>
    <Notice error>{message(q.error?.message || "")}</Notice>
    {!!active.length && <div className="active-attribute-filters" aria-label={ui("search.active_filters", "Active filters")}>
      <strong>{ui("search.shopping_by", "Shopping by")}</strong>
      <div>{active.map(item => <button type="button" key={JSON.stringify([item.code,item.value])}
        aria-label={ui("search.remove_filter", "Remove {attribute}: {value}", {attribute:item.label,value:item.option})}
        onClick={() => onRemove(item.code,item.value)}><span>{item.label}: {item.option}</span><span aria-hidden="true">×</span></button>)}</div>
    </div>}
    {definitions.map(d => {
      const selected = selectedAttributeValues(values[d.attribute_code]);
      const checkboxes = d.input_type === "boolean" || ["select","multiselect","single_select","multi_select"].includes(d.input_type)
        || (["text","textarea","long_text"].includes(d.input_type) && d.metadata?.facetable);
      const options = checkboxes ? attributeFilterOptions(d,facets,selected,ui("common.yes","Yes"),ui("common.no","No")) : [];
      if (checkboxes && !options.length && facets !== undefined && d.metadata?.facetable) return null;
      const isCollapsed = collapsed[d.attribute_code] ?? defaultCollapsed;
      return <details className="attribute-checkbox-filter" key={d.attribute_code} open={!isCollapsed}>
        <summary onClick={event => { event.preventDefault(); onToggle(d.attribute_code,!isCollapsed); }}>{d.label}{selected.length > 0 && <small>{selected.length}</small>}</summary>
        <div className="attribute-filter-body">
          {checkboxes ? <fieldset aria-label={d.label}>
            <legend className="sr-only">{d.label}</legend>
            <input type="hidden" name={`attr-mode:${d.attribute_code}`} value="multiple" />
            <div className="attribute-checkbox-options">{options.map(o => <label className="checkbox" key={o.value}>
              <input type="checkbox" name={`attr:${d.attribute_code}`} value={o.value}
                aria-label={`${d.label}: ${o.label}`} defaultChecked={selected.includes(o.value)} />
              <span>{o.label}</span>{o.count !== undefined && <small className="attribute-option-count">({o.count})</small>}
            </label>)}</div>
          </fieldset> : <label className="field"><span className="sr-only">{d.label}</span><input
            name={`attr:${d.attribute_code}`} defaultValue={String(values[d.attribute_code] ?? "")}
            placeholder={ui("search.exact_attribute", "Exact {attribute}{unit}", {attribute:d.label.toLowerCase(),unit:d.metadata?.unit?` (${d.metadata.unit})`:""})}
            type={["integer","decimal","measurement","price"].includes(d.input_type)?"number":d.input_type==="date"?"date":"text"}
            step={d.input_type==="integer"?"1":"any"} min={d.metadata?.min??undefined} max={d.metadata?.max??undefined} />
          </label>}
          <input type="hidden" name={`attr-type:${d.attribute_code}`} value={d.input_type} />
        </div>
      </details>;
    })}
  </>;
}
export function DisplayAttributes({ product }: { product: Product }) {
  const { locale } = useInterface();
  const q = useQuery({
    queryKey: ["public-attributes", locale],
    queryFn: () => attributeApi.public(locale),
  });
  return (
    <>
      {Object.entries(product.attributes).map(([code, v]) => {
        const d = q.data?.find((d) => d.attribute_code === code);
        if (d && !d.is_visible_on_front) return null;
        const display = (v: unknown) =>
          d?.options.find((o) => o.value === v)?.label ??
          (typeof v === "boolean" ? (v ? "Yes" : "No") : String(v));
        return (
          <div key={code}>
            <dt>
              {d?.label ?? code.replaceAll("-", " ").replaceAll("_", " ")}
            </dt>
            <dd>
              {Array.isArray(v) ? (
                v.map(display).join(", ")
              ) : d?.input_type === "media_image" ? (
                <img
                  src={`/api/v1/catalog/media/${v}/content`}
                  alt={d.label}
                  width="100"
                />
              ) : (
                display(v)
              )}
            </dd>
          </div>
        );
      })}
    </>
  );
}
