import { EntityIdHeading, EntityIdCell } from "./entity-id";
import { EntityMarketEditor, useEditorMarket } from "./markets";
import { EntityTranslationEditor, useEditorLanguage, type EditorState, type TranslationEditorFields } from "./entity-translation";
import { SourceEditorGuard } from "./unsaved-changes";
import "./product-categories.css";
import { ProductCategoryPicker } from "./category-picker";
import { MediaLibrary } from "./media-library";
import { CategoryManagement } from "./category-management";
import { RowActions } from "./row-actions";
import { ProductImages } from "./product-images";
import { PageHeader } from "./page-header";
import { ProductSourceQuantities } from "./msi";
import {
  AttributeDefinitions,
  ProductStructureEditor,
} from "./attributes";
import { useGrid } from "./grids";
import { ProductOperations } from "./operations";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  attributeApi,
  catalogSchemaApi,
  catalogApi,
  mediaUrl,
  type Product,
  type ProductInput,
  type AttributeInput,
} from "@commerce/api-client";
import { AttributeFields, Field, Notice, useAction } from "@commerce/ui";
import "./catalog.css";
type Section = "products" | "categories" | "attributes" | "media";
const isSeoAttribute = (code: string, label = "", group = "") =>
  /(?:^|[_-])(seo|meta|canonical|robots)(?:$|[_-])/.test(code.toLowerCase()) ||
  /\b(?:seo|search engine optimization|meta title|meta keywords?|meta description|canonical url|robots)\b/i.test(`${label} ${group}`);
export function Catalog({
  section,
  canWrite,
  permissions = [],
}: {
  section: Section;
  canWrite: boolean;
  permissions?: string[];
}) {
  const navigate = useNavigate();
  if (section === "categories") return <CategoryManagement canWrite={canWrite} permissions={permissions}/>;
  const heading = section[0].toUpperCase() + section.slice(1);
  return (
    <main className="catalog-admin">
      {section !== "attributes" && (
        <PageHeader title={<>{heading}</>} description={<>
              {section === "products"
                ? "Manage products, variants, groups, prices, and availability."
                : "Organize images into folders, upload media, and manage image details."}
            </>} actions={<>{section === "products" && canWrite && (
            <button onClick={() => navigate("/catalog/products/new")}>
              Add Product
            </button>
          )}</>} />
      )}
      {section === "products" ? (
        <ProductOperations
          canWrite={canWrite}
          canBulk={
            permissions.includes("*") || permissions.includes("catalog.bulk")
          }
        />

      ) : section === "attributes" ? (
        <>
          <AttributeDefinitions
            canWrite={
              permissions.includes("*") ||
              permissions.includes("attributes.write")
            }
          />
          <h2>Legacy product attributes</h2>
          <Attributes canWrite={canWrite} />
        </>
      ) : (
        <MediaLibrary canWrite={canWrite} />
      )}
    </main>
  );
}
export function useCatalogRefresh() {
  const client = useQueryClient();
  return () =>
    client.invalidateQueries({ predicate: (q) => q.queryKey[0] === "catalog" });
}
const blank: ProductInput = {
  sku: "",
  slug: "",
  name: "",
  description: "",
  price: "0.00",
  currency: "USD",
  unit: "each",
  category_id: "",
  category_ids: [],
  attribute_set_id: null,
  attributes: {},
  media_ids: [],
  active: true,
  in_stock: true,
};
export function ProductForm({
  product,
  close,
  onStateChange,
  canReadSeo = false,
  translation,
}: {
  translation?: TranslationEditorFields;
  canReadSeo?: boolean;
  product: Product | null;
  close: () => void;
  onStateChange?: (state: EditorState) => void;
}) {
  const [form, setForm] = useState<ProductInput>(
    product
      ? {
          sku: product.sku,
          slug: product.slug,
          name: product.name,
          description: product.description,
          price: product.price,
          currency: product.currency,
          unit: product.unit,
          category_id: product.category_id,
          category_ids: product.category_ids ?? [product.category_id],
          attribute_set_id: product.attribute_set_id,
          attributes: product.attributes,
          media_ids: product.media_ids,
          active: product.active,
          in_stock: product.in_stock,
        }
      : blank,
  );
  const [initialForm] = useState(form);
  const dirty = JSON.stringify(form) !== JSON.stringify(initialForm);
  const leave = useRef<() => void>(() => {});
  const Form = translation ? "div" : "form";
  const [activeSection, setActiveSection] = useState("information");
  const [setError,setSetError]=useState("");
  const cats = useQuery({
    queryKey: ["catalog", "categories", "tree"],
    queryFn: catalogApi.adminCategories,
  });
  const typed = useQuery({
    queryKey: ["attribute-definitions", "product"],
    queryFn: () => attributeApi.list("product"),
  });
  const sets = useQuery({
    queryKey: ["attribute-sets"],
    queryFn: attributeApi.sets,
  });
  const defaultSetChosen = useRef(false);
  const configuration = useQuery({
    queryKey: ["catalog-configuration"],
    queryFn: catalogSchemaApi.configuration,
    enabled: !product,
  });
  useEffect(() => {
    if (product || defaultSetChosen.current || !configuration.data || !sets.data) return;
    defaultSetChosen.current = true;
    const id = configuration.data.default_attribute_set_id;
    if (id && sets.data.some(set => set.id === id)) {
      setForm(current => current.attribute_set_id || Object.keys(current.attributes).length ? current : {...current, attribute_set_id: id});
    }
  }, [product, configuration.data, sets.data]);
  const attrs = useQuery({
    queryKey: ["catalog", "attributes"],
    queryFn: catalogApi.attributes,
  });
  const media = useQuery({
    queryKey: ["catalog", "media"],
    queryFn: catalogApi.mediaList,
  });
  const a = useAction();
  const refresh = useCatalogRefresh();
  useLayoutEffect(() => { onStateChange?.({dirty, busy:a.busy}); }, [dirty, a.busy, onStateChange]);
  const change = <K extends keyof ProductInput>(k: K, v: ProductInput[K]) =>
    setForm((f) => ({ ...f, [k]: v }));
  const selectedSet = sets.data?.find(set => set.id === form.attribute_set_id);
  const seoCodes = new Set([
    ...(attrs.data ?? []).filter(attr => isSeoAttribute(attr.code, attr.name)).map(attr => attr.code),
    ...(typed.data ?? []).filter(definition =>
      isSeoAttribute(definition.attribute_code, definition.label,
        selectedSet?.members.find(member => member.definition_id === definition.id)?.group_name),
    ).map(definition => definition.attribute_code),
  ]);
  const isSeoCode = (code: string) => seoCodes.has(code) || isSeoAttribute(code);
  const renderLegacyAttributes = (seo: boolean) => attrs.data?.filter(attr => isSeoAttribute(attr.code, attr.name) === seo).map((attr) => {
            const value = form.attributes[attr.code];
            const update = (value: unknown) => {
              const next = { ...form.attributes };
              if (value === undefined) delete next[attr.code];
              else next[attr.code] = value;
              change("attributes", next);
            };
            return attr.kind === "boolean" ? (
              <label className="field" key={attr.id}>
                {attr.name}
                {attr.required ? " *" : ""}
                <select
                  required={attr.required}
                  value={value === undefined ? "" : String(value)}
                  onChange={(e) =>
                    update(
                      e.target.value === ""
                        ? undefined
                        : e.target.value === "true",
                    )
                  }
                >
                  <option value="">Not set</option>
                  <option value="true">Yes</option>
                  <option value="false">No</option>
                </select>
              </label>
            ) : (
              <Field
                key={attr.id}
                label={attr.name + (attr.required ? " *" : "")}
                type={attr.kind === "number" ? "number" : "text"}
                step={attr.kind === "number" ? "any" : undefined}
                required={attr.required}
                value={value === undefined ? "" : String(value)}
                onChange={(e) =>
                  update(
                    e.target.value === ""
                      ? undefined
                      : attr.kind === "number"
                        ? Number(e.target.value)
                        : e.target.value,
                  )
                }
              />
            );
          });
  const renderProductAttributes = (seo: boolean) => {
    const groups = selectedSet
      ? [...new Set(selectedSet.members.map(member => member.group_name))]
      : ["Advanced / custom attributes"];
    const fields = groups.map(group => {
      const definitions = (typed.data ?? []).filter(definition =>
        (!selectedSet || selectedSet.members.some(member => member.definition_id === definition.id && member.group_name === group)) &&
        (isSeoAttribute(definition.attribute_code, definition.label, group) === seo),
      ).sort((a, b) => selectedSet
        ? (selectedSet.members.find(member => member.definition_id === a.id)?.position ?? 0) - (selectedSet.members.find(member => member.definition_id === b.id)?.position ?? 0)
        : (a.metadata?.display_order ?? 0) - (b.metadata?.display_order ?? 0));
      return definitions.length ? <fieldset key={group}><legend>{group}</legend><AttributeFields imageUrl={mediaUrl} definitions={definitions} values={form.attributes} onChange={values => change("attributes", values)} media={media.data}/></fieldset> : null;
    });
    const outsideSet = selectedSet ? (typed.data ?? []).filter(definition =>
      !selectedSet.members.some(member => member.definition_id === definition.id) &&
      Object.prototype.hasOwnProperty.call(form.attributes, definition.attribute_code) &&
      isSeoCode(definition.attribute_code) === seo,
    ) : [];
    if (outsideSet.length) fields.push(<fieldset key="saved-outside-set"><legend>Saved attributes outside this set</legend><AttributeFields imageUrl={mediaUrl} definitions={outsideSet} values={form.attributes} onChange={values => change("attributes", values)} media={media.data}/></fieldset>);
    return fields;
  };
  async function submit(e: FormEvent) {
    e.preventDefault();
    await a.run(async () => {
      await catalogApi.saveProduct(product?.id ?? null, form);
      await refresh();
      leave.current();
      close();
    });
  }
  return (
    <section className="catalog-editor">
      {!translation && <SourceEditorGuard dirty={dirty} leave={leave}/>}
      <div className="catalog-toolbar">
        <h2>{product ? `Edit ${product.name}` : "New simple product"}</h2>
        <button type="button" className="secondary" onClick={close}>
          Close
        </button>
      </div>
      <Notice error>
        {setError || a.error ||
          cats.error?.message ||
          attrs.error?.message ||
          media.error?.message}
      </Notice>
      <div className="order-detail-layout product-editor-layout">
        <aside className="order-subnav" aria-label="Product sections">
          {[
            ["information", "Information"],
            ["category", "Category"],
            ["pricing", "Pricing"],
            ["attributes", "Attributes"],
            ["images", "Images"],
            ["seo", "SEO"],
            ["inventory", "Inventory & structure"],
            ["publishing", "Publishing"],
          ].map(([key, label]) => <button type="button" key={key}
            className={activeSection === key ? "active" : ""}
            aria-current={activeSection === key ? "true" : undefined}
            aria-controls={`product-section-${key}`}
            onClick={() => setActiveSection(key)}>{label}</button>)}
        </aside>
        <div className="order-section-content">
      <Form onSubmit={translation ? undefined : submit} onInvalidCapture={(event) => {
        const field = event.target as HTMLInputElement;
        const firstInvalid = event.currentTarget.querySelector("input:invalid, select:invalid, textarea:invalid");
        if (field !== firstInvalid) { event.preventDefault(); return; }
        const section = field.closest<HTMLElement>("[data-product-section]");
        if (section?.hidden) {
          event.preventDefault();
          setActiveSection(section.dataset.productSection!);
          requestAnimationFrame(() => { field.focus(); field.reportValidity(); });
        }
      }}>
        <section className="order-panel product-editor-panel" id="product-section-information" data-product-section="information" hidden={activeSection !== "information"} aria-label="Information">
          <h2>Information</h2>
        <div className="form-grid">
          {translation ? translation.field("name", "Product name") : <>
          <Field
            label="Product name"
            value={form.name}
            required
            maxLength={200}
            onChange={(e) => change("name", e.target.value)}
          />
          </>}
          <Field
            label="SKU"
            disabled={!!translation}
            value={form.sku}
            required
            maxLength={80}
            onChange={(e) => change("sku", e.target.value)}
          />
        </div>
        {translation ? translation.field("description") : <>
        <label className="field">
          Description
          <textarea
            rows={4}
            maxLength={10000}
            value={form.description}
            onChange={(e) => change("description", e.target.value)}
          />
        </label>
        </>}
        </section>
        <fieldset disabled={!!translation} className="order-panel product-editor-panel" id="product-section-category" data-product-section="category" hidden={activeSection !== "category"} aria-label="Category">
          <h2>Category</h2>
          <ProductCategoryPicker categories={cats.data ?? []} values={form.category_ids ?? []} primary={form.category_id} loading={cats.isPending} error={cats.error?.message} retry={() => void cats.refetch()} disabled={a.busy} onChange={(category_ids, category_id) => setForm(current => ({ ...current, category_ids, category_id }))} />
        </fieldset>
        <section className="order-panel product-editor-panel" id="product-section-seo" data-product-section="seo" hidden={activeSection !== "seo"} aria-label="SEO">
          <h2>SEO</h2>
          {translation ? <>
            {Object.keys(translation.source).filter(key => key.startsWith("attribute.") && isSeoCode(key.slice("attribute.".length))).map(key => translation.field(key))}
            <details><summary>Shared SEO values</summary><fieldset disabled><AttributeFields imageUrl={mediaUrl} definitions={(typed.data ?? []).filter(definition => isSeoCode(definition.attribute_code))} values={form.attributes} onChange={() => {}} media={media.data}/></fieldset></details>
          </> : <fieldset>
          <p className="help">Set the URL used for this product’s storefront page.</p>
          <Field
            label="URL slug"
            value={form.slug}
            required
            pattern="[a-z0-9-]+"
            onChange={(e) => change("slug", e.target.value)}
          />
          <p className="help">Product URL: <code>/products/{form.slug || "your-product"}</code></p>
          <div className="form-grid">{renderLegacyAttributes(true)}</div>
          {renderProductAttributes(true)}
          {canReadSeo && <p className="help">Manage storewide search appearance in <Link to="/system/configuration/discoverability/seo">SEO settings</Link>.</p>}
          </fieldset>}
        </section>
        <fieldset disabled={!!translation} className="order-panel product-editor-panel" id="product-section-pricing" data-product-section="pricing" hidden={activeSection !== "pricing"} aria-label="Pricing">
          <h2>Pricing</h2>
        <div className="form-grid">
          <Field
            label="Price (USD)"
            type="number"
            min="0"
            max="9999999999"
            step="0.01"
            required
            value={form.price}
            onChange={(e) => change("price", e.target.value)}
          />
          <label className="field">
            Unit
            <select
              value={form.unit}
              onChange={(e) =>
                change("unit", e.target.value as ProductInput["unit"])
              }
            >
              {["each", "lb", "kg", "oz", "pack", "L"].map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          </label>
        </div>
        </fieldset>
        <section className="order-panel product-editor-panel" id="product-section-attributes" data-product-section="attributes" hidden={activeSection !== "attributes"} aria-label="Attributes">
          <h2>Attributes</h2>
        {translation ? <>
          <p className="help">Translate text values below. Translate choice labels in Catalog → Attributes.</p>
          {Object.keys(translation.source).filter(key=>key.startsWith('attribute.') && !isSeoCode(key.slice('attribute.'.length))).map(key=>translation.field(key))}
          {!Object.keys(translation.source).some(key=>key.startsWith('attribute.') && !isSeoCode(key.slice('attribute.'.length))) && <p>No saved text attributes to translate.</p>}
          <details><summary>Shared attribute values</summary><fieldset disabled><AttributeFields imageUrl={mediaUrl} definitions={(typed.data ?? []).filter(definition => !isSeoCode(definition.attribute_code))} values={form.attributes} onChange={()=>{}} media={media.data}/></fieldset></details>
        </> : <>
        <div className="form-grid">
          <label className="field">
            Attribute set
            <select
              value={form.attribute_set_id ?? ""}
              onChange={(e) => {
                defaultSetChosen.current = true;
                const setId = e.target.value || null;
                const selected = sets.data?.find((s) => s.id === setId);
                const allowed = new Set(selected?.members.map((m) => m.definition_id));
                const modernCodes = new Map(typed.data?.map((d) => [d.id, d.attribute_code]));
                const excluded = [...modernCodes].filter(([id, code]) => !allowed.has(id) && Object.prototype.hasOwnProperty.call(form.attributes, code)).map(([, code]) => code);
                if (selected && excluded.length) { setSetError(`${selected.name} excludes saved attributes: ${excluded.join(', ')}. Use all product attributes below, or add these fields to the set. Your values have been preserved.`); return; }
                setSetError('');change("attribute_set_id", setId);
              }}
            >
              <option value="">All product attributes</option>
              {sets.data?.map((set) => <option key={set.id} value={set.id}>{set.name}</option>)}
            </select>
          </label>
        </div>
        {(setError || (selectedSet && (typed.data ?? []).some(definition =>
          !selectedSet.members.some(member => member.definition_id === definition.id) &&
          Object.prototype.hasOwnProperty.call(form.attributes, definition.attribute_code),
        ))) && <div role="status">
          <p>This product has saved attributes outside the selected set. Use all product attributes to keep editing and save every value.</p>
          <button type="button" className="secondary" onClick={() => {
            defaultSetChosen.current = true;
            setSetError("");
            change("attribute_set_id", null);
          }}>Use all product attributes</button>
          <p><Link to="/catalog/attributes/sets">Manage attribute set membership</Link></p>
        </div>}
        <h3>Attributes</h3>
        {attrs.data?.length === 0 && (
          <p className="help">
            Create attribute definitions under Catalog → Attributes to add
            product details.
          </p>
        )}
        <div className="form-grid">
          {renderLegacyAttributes(false)}
        </div>
        <h3>Product attributes</h3>
        <p className="help">Fields follow the assigned attribute set. Industry recommendations can be configured under Settings / Catalog.</p>
        {renderProductAttributes(false)}
        </>}
        </section>
        <fieldset disabled={!!translation} className="order-panel product-editor-panel" id="product-section-images" data-product-section="images" hidden={activeSection !== "images"} aria-label="Images">
          <h2>Images</h2>
        <ProductImages ids={form.media_ids} onChange={ids => change("media_ids", ids)} disabled={a.busy}/>
        </fieldset>
        <fieldset disabled={!!translation} className="order-panel product-editor-panel" id="product-section-publishing" data-product-section="publishing" hidden={activeSection !== "publishing"} aria-label="Publishing">
          <h2>Publishing</h2>
        <div className="row">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={form.active}
              onChange={(e) => change("active", e.target.checked)}
            />
            Published
          </label>
          <p className="help">
            Availability is managed in Catalog → Inventory.
          </p>
        </div>
        </fieldset>
        {!translation && <>
        <div className="product-editor-actions">
        <button disabled={a.busy || !cats.data || !attrs.data}>
          Save product
        </button>
        <p className="help">
          Published changes appear in storefront search within a few seconds.
        </p>
        </div>
        </>}
      </Form>
      <section className="order-panel product-editor-panel" id="product-section-inventory" hidden={activeSection !== "inventory"} aria-label="Inventory & structure">
        <h2>Inventory &amp; structure</h2>

      {translation && product && <p>Product type: {product.product_type}. Inventory and structure are shared across languages. Switch to the source language to manage them.</p>}
      {!translation && product && <ProductSourceQuantities productId={product.id} />}
      {!translation && product && <ProductStructureEditor product={product} />}
      {!product && (
        <p>
          Save the product, then open Edit to configure its type and children.
        </p>
      )}
      </section>
        </div>
      </div>
    </section>
  );
}

export function ProductEditorPage({ permissions = [] }: { permissions?: string[] }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const isNew = id === "new";
  const has = (permission: string) => permissions.includes("*") || permissions.includes(permission);
  const scope = useEditorLanguage({canRead:has("languages.read") && has("catalog.read"),persisted:!isNew && !!id});
  const marketScope = useEditorMarket(has("markets.read"), scope.dirty || scope.busy || isNew || !id);
  const product = useQuery({
    queryKey: ["catalog", "product", id],
    queryFn: () => catalogApi.adminProduct(id!),
    enabled: !isNew && !!id,
  });
  if (!isNew && product.isPending) return <main><p role="status">Loading product details…</p></main>;
  if (!isNew && (product.error || !product.data)) return <main><PageHeader title={<>Product unavailable</>} /><Notice error>{product.error?.message || "This product could not be loaded."}</Notice><button className="secondary" onClick={()=>navigate("/catalog/products")}>Back to products</button></main>;
  return <main className="product-detail-page">
    <button className="text-button back-link" onClick={()=>navigate("/catalog/products")}>← Products</button>
    <PageHeader title={<>{isNew ? "New product" : product.data!.name}</>} description={<>{isNew ? "Create a product and configure its commercial details." : `SKU ${product.data!.sku}`}</>} actions={<div className="market-editor-actions">{marketScope.toolbar}<fieldset disabled={!!marketScope.market}>{scope.toolbar}</fieldset></div>} />
    {marketScope.market && !isNew ? <EntityMarketEditor key={`${id}-${marketScope.market.id}`} market={marketScope.market} kind="product" id={id!} canWrite={has("markets.write") && has("catalog.write")} onStateChange={scope.onEditorStateChange}/> : scope.language && !isNew ? <EntityTranslationEditor key={`${id}-${scope.locale}`} kind="product" id={id!} language={scope.language} canWrite={has("languages.write") && has("catalog.write")} onStateChange={scope.onEditorStateChange} renderEditor={translation => <ProductForm product={product.data!} translation={translation} canReadSeo={has("discovery.read")} close={()=>navigate("/catalog/products")}/>} /> : <ProductForm key={id} canReadSeo={has("discovery.read")} product={isNew ? null : product.data!} onStateChange={scope.onEditorStateChange} close={()=>navigate("/catalog/products")}/> }
  </main>;
}
function Attributes({ canWrite }: { canWrite: boolean }) {
  const refresh = useCatalogRefresh();
  const navigate = useNavigate();
  const q = useGrid(
    "attributes",
    ["catalog", "attributes"],
  );
  const a = useAction();
  return (
    <>
      <div className="catalog-toolbar">
        <span>{q.data?.length ?? 0} attribute definitions</span>
        {canWrite && (
          <button onClick={() => navigate("/catalog/attributes/legacy/new")}>+ New legacy attribute</button>
        )}
      </div>
      {q.controls}
      <Notice error>{q.error?.message || a.error}</Notice>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <EntityIdHeading/><th>Name</th>
              <th>Code</th>
              <th>Type</th>
              <th>Required</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {q.data?.map((attr) => (
              <tr key={attr.id}>
                <EntityIdCell row={attr}/><td>{attr.name}</td>
                <td>{attr.code}</td>
                <td>{attr.kind}</td>
                <td>{attr.required ? "Yes" : "No"}</td>
                <td>
                  {canWrite && (
                    <RowActions label={attr.name} items={[
                      { label: "Edit", onSelect: () => navigate(`/catalog/attributes/legacy/${attr.id}`) },
                      { label: "Delete", destructive: true, confirm: "This permanently removes the record. This action cannot be undone.", onSelect: async () => { await catalogApi.deleteAttribute(attr.id); await refresh(); } },
                    ]} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
export function LegacyAttributeEditorPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const isNew = id === "new";
  const attributes = useQuery({ queryKey: ["catalog", "attributes"], queryFn: catalogApi.attributes });
  const attribute = isNew ? undefined : attributes.data?.find((item) => item.id === id);
  const action = useAction();
  if (!isNew && attributes.isPending) return <main><p role="status">Loading attribute…</p></main>;
  if (!isNew && !attribute) return <main><PageHeader title={<>Attribute unavailable</>} /><Notice error>{attributes.error?.message || "Attribute not found"}</Notice><button onClick={() => navigate("/catalog/attributes")}>Back to attributes</button></main>;
  return <main className="product-detail-page"><button className="text-button back-link" onClick={() => navigate("/catalog/attributes")}>← Attributes</button><PageHeader title={<>{isNew ? "New legacy attribute" : attribute!.name}</>} description={<>Legacy compatibility field. Use typed attributes for new catalog designs.</>} /><form className="catalog-editor standalone-editor" onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); const input: AttributeInput = { name: String(data.get("name")), code: String(data.get("code")), kind: data.get("kind") as AttributeInput["kind"], required: data.has("required") }; void action.run(async () => { await catalogApi.saveAttribute(isNew ? null : id!, input); navigate("/catalog/attributes"); }); }}><Notice error>{action.error || attributes.error?.message}</Notice><div className="form-grid"><Field label="Name" name="name" required maxLength={120} defaultValue={attribute?.name}/><Field label="Code" name="code" required pattern="[a-z0-9-]+" defaultValue={attribute?.code}/></div><label className="field">Type<select name="kind" defaultValue={attribute?.kind ?? "text"}><option value="text">Text</option><option value="number">Number</option><option value="boolean">Yes / No</option></select></label><label className="checkbox"><input name="required" type="checkbox" defaultChecked={attribute?.required}/>Required on every product</label><p className="help">Codes and types cannot change while the attribute is in use.</p><div className="row"><button disabled={action.busy}>Save attribute</button><button type="button" className="secondary" onClick={() => navigate("/catalog/attributes")}>Cancel</button></div></form></main>;
}
