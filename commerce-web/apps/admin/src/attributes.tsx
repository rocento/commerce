import { EntityIdHeading, EntityIdCell, EntityIdLabel } from "./entity-id";
import { supportsCustomerSegments } from './customer-attribute-policy';
import { EntityTranslationEditor, useEditorLanguage, type EditorState, type TranslationEditorFields } from "./entity-translation";
import { SourceEditorGuard } from "./unsaved-changes";
import { RowActions } from "./row-actions";
import { PageHeader } from "./page-header";
import { useGrid } from "./grids";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Navigate, NavLink, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  attributeApi,
  catalogApi,
  mediaUrl,
  operationsApi,
  type AttributeDefinition,
  type AttributeMetadata,
  type AttributeSet,
  type Product,
  type ProductStructure,
} from "@commerce/api-client";
import { AttributeFields, Field, Notice, useAction } from "@commerce/ui";
const flags = {
  is_required: "Required",
  is_unique: "Unique",
  is_searchable: "Searchable",
  is_filterable: "Storefront filter",
  is_comparable: "Comparable",
  is_visible_on_front: "Visible on storefront",
  used_for_promo_rules: "Available for promotions",
  used_for_configurations: "Used for configurations",
} as const;
const fresh = (
  entity_type: AttributeDefinition["entity_type"],
): AttributeDefinition => ({
  id: crypto.randomUUID(),
  entity_type,
  attribute_code: "",
  label: "",
  input_type: "text",
  scope: "global",
  options: [],
  swatch_type: "none",
  version: 0,
  is_required: false,
  is_unique: false,
  is_searchable: false,
  is_filterable: false,
  is_comparable: false,
  is_visible_on_front: false,
  used_for_promo_rules: false,
  used_for_configurations: false,
});
export function AttributeDefinitions({ canWrite, view = "attributes" }: { canWrite: boolean; view?: "attributes" | "sets" }) {
  const navigate = useNavigate();
  const [entity, setEntity] = useState<AttributeDefinition["entity_type"]>("product");
  return (
    <section className="attributes-admin">
      <PageHeader title={<>{view === "sets" ? "Attribute sets" : "Attributes"}</>} description={<>Manage reusable attributes and organize them into attribute sets for your catalog.</>} actions={<>{canWrite && <div className="header-actions-row attribute-create-actions">
          <button onClick={() => navigate(`/catalog/attributes/definitions/new?entity=${entity}`)}>New attribute</button>
          <button className="secondary" onClick={() => navigate("/catalog/attributes/sets/new")}>New attribute set</button>
        </div>}</>} />
      <nav className="attribute-tabs" aria-label="Attribute management">
        <NavLink end to="/catalog/attributes">Attributes</NavLink>
        <NavLink end to="/catalog/attributes/sets">Attribute sets</NavLink>
      </nav>
      {view === "attributes" ? <DefinitionsPanel canWrite={canWrite} entity={entity} setEntity={setEntity} /> : <AttributeSetsPanel canWrite={canWrite} />}
    </section>
  );
}
function DefinitionsPanel({ canWrite, entity, setEntity }: {
  canWrite: boolean;
  entity: AttributeDefinition["entity_type"];
  setEntity: (entity: AttributeDefinition["entity_type"]) => void;
}) {
  const navigate = useNavigate();
  const a = useAction();
  const q = useGrid(
    "attribute-definitions",
    ["attribute-definitions"],
    { entity_type: entity },
  );
  return (
    <section className="attribute-workspace">
      <div className="attribute-section-head"><div><h2>Attribute library</h2><p>Define reusable fields, validation, storefront behavior, and catalog usage.</p></div></div>
      <div className="attribute-stats">
        <article><strong>{q.data?.length ?? 0}</strong><span>Attributes on this page</span></article>
        <article><strong>{q.data?.filter(d => d.is_required).length ?? 0}</strong><span>Required</span></article>
        <article><strong>{q.data?.filter(d => d.is_filterable).length ?? 0}</strong><span>Storefront filters</span></article>
        <article><strong>{q.data?.filter(d => d.used_for_configurations).length ?? 0}</strong><span>Variant attributes</span></article>
      </div>
      <Notice error>{q.error?.message || a.error}</Notice><Notice>{a.message}</Notice>
      {q.renderControls({ filters: <label className="grid-field">Entity<select value={entity} onChange={e => setEntity(e.target.value as AttributeDefinition["entity_type"])}><option value="product">Products</option><option value="category">Categories</option></select></label> })}
      <div className="table-wrap"><table><thead><tr><EntityIdHeading/><th>Label / code</th><th>Input</th><th>Usage</th><th>Actions</th></tr></thead><tbody>
        {q.data?.map(d => <tr key={d.id}><EntityIdCell row={d}/><td><strong>{d.label}</strong><small className="attribute-code">{d.attribute_code}</small></td><td><span className="badge">{d.input_type}</span></td><td>{[d.is_required && "Required", d.is_filterable && "Filter", d.used_for_configurations && "Variants"].filter(Boolean).join(" · ") || "Standard"}</td><td>{canWrite && <RowActions label={d.label} items={[{ label: "Edit", onSelect: () => navigate(`/catalog/attributes/definitions/${d.id}`) }]} />}</td></tr>)}
        {!q.isPending && !q.error && !q.data?.length && <tr><td colSpan={6}>No attributes match these filters.</td></tr>}
      </tbody></table></div>
    </section>
  );
}

function AttributeDefinitionForm({ initial, translation, onStateChange }: { initial: AttributeDefinition; translation?: TranslationEditorFields; onStateChange?: (state:EditorState)=>void }) {
  const returnPath = initial.entity_type === "customer" ? "/customers/attributes" : "/catalog/attributes";
  const [form, setForm] = useState(initial);
  const navigate = useNavigate();
  const a = useAction();
  const cache = useQueryClient();
  const leave = useRef<() => void>(()=>{});
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  useLayoutEffect(()=>{onStateChange?.({dirty,busy:a.busy});},[dirty,a.busy,onStateChange]);
  const Form = translation ? 'div' : 'form';
  return <Form className="form-card attribute-editor standalone-editor" onSubmit={(e) => {
    e.preventDefault();
    if (translation) return;
    void a.run(async () => {
      await attributeApi.save(form.entity_type === "customer" && !supportsCustomerSegments(form.input_type) ? {...form, used_for_promo_rules: false} : form);
      await cache.invalidateQueries({ queryKey: ["attribute-definitions"] });
      leave.current();
      navigate(returnPath);
    });
  }}>
          {!translation && <SourceEditorGuard dirty={dirty} leave={leave}/>}
          <Notice error>{a.error}</Notice>
          <h3>
            {form.version ? "Edit" : "New"} {form.entity_type} attribute
          </h3>
          <Field
            label="Attribute code"
            required
            pattern="[a-z][a-z0-9_-]*"
            disabled={!!translation || form.version > 0}
            value={form.attribute_code}
            onChange={(e) =>
              setForm({ ...form, attribute_code: e.target.value })
            }
          />
          {translation ? translation.field("label") : <>
          <Field
            label="Label"
            required
            value={form.label}
            onChange={(e) => setForm({ ...form, label: e.target.value })}
          />
          </>}
          <label className="field">
            Input type
            <select
              disabled={!!translation || form.version > 0}
              value={form.input_type}
              onChange={(e) =>
                setForm({
                  ...form,
                  input_type: e.target
                    .value as AttributeDefinition["input_type"],
                  used_for_promo_rules: form.entity_type === "customer" && !supportsCustomerSegments(e.target.value) ? false : form.used_for_promo_rules,
                  options: [],
                  used_for_configurations: false,
                  swatch_type: "none",
                })
              }
            >
              {[
                "text",
                "textarea",
                "boolean",
                "select",
                "multiselect",
                "price",
                "date",
                "media_image", "integer", "decimal", "datetime", "measurement", "long_text", "single_select", "multi_select",
              ].map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
          {translation?.field("description")}
          {form.entity_type === "customer" && !supportsCustomerSegments(form.input_type) && <p>This input type cannot be used in segment conditions.</p>}
          <fieldset disabled={!!translation}><AttributeMetadataEditor hideDescription={!!translation} definition={form} value={form.metadata??{}} onChange={metadata=>setForm({...form,metadata})}/></fieldset>
          {Object.entries(flags).filter(([key]) => form.entity_type !== "customer" || ["is_required", "is_unique", "used_for_promo_rules"].includes(key)).map(([key, label]) => (
            <label className="check" key={key}>
              <input
                type="checkbox"
                disabled={!!translation ||
                  (form.entity_type === "customer" && key === "used_for_promo_rules" && !supportsCustomerSegments(form.input_type)) ||
                  (form.entity_type === "customer" &&
                    [
                      "is_searchable",
                      "is_filterable",
                      "is_visible_on_front",
                    ].includes(key)) ||
                  (key === "used_for_configurations" &&
                    (form.entity_type !== "product" || form.input_type !== "select"))
                }
                checked={form[key as keyof typeof flags]}
                onChange={(e) => setForm({ ...form, [key]: e.target.checked })}
              />
              {form.entity_type === "customer" && key === "used_for_promo_rules" ? "Use in segments" : label}
            </label>
          ))}
          {["select", "multiselect", "single_select", "multi_select"].includes(form.input_type) && (
            <fieldset>
              <legend>Options</legend>
              {form.options.map((o, i) => (
                <div className="form-grid" key={i}>
                  <Field
                    label={`Option ${i + 1} value`}
                    disabled={!!translation}
                    required
                    value={o.value}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        options: form.options.map((v, n) =>
                          n === i ? { ...v, value: e.target.value } : v,
                        ),
                      })
                    }
                  />
                  {translation ? translation.field(`option.${o.value}`, `Option ${i + 1} label`) : <>
                  <Field
                    label={`Option ${i + 1} label`}
                    required
                    value={o.label}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        options: form.options.map((v, n) =>
                          n === i ? { ...v, label: e.target.value } : v,
                        ),
                      })
                    }
                  />
                  </>}
                  <button
                    type="button"
                    disabled={!!translation}
                    onClick={() =>
                      setForm({
                        ...form,
                        options: form.options.filter((_, n) => n !== i),
                      })
                    }
                  >
                    Remove option
                  </button>
                </div>
              ))}
              <button
                type="button"
                disabled={!!translation}
                onClick={() =>
                  setForm({
                    ...form,
                    options: [...form.options, { value: "", label: "" }],
                  })
                }
              >
                Add option
              </button>
              <label className="field">
                Swatch metadata
                <select
                  disabled={!!translation}
                  value={form.swatch_type}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      swatch_type: e.target
                        .value as AttributeDefinition["swatch_type"],
                    })
                  }
                >
                  <option>none</option>
                  <option>text</option>
                  <option>color</option>
                </select>
              </label>
            </fieldset>
          )}
          <p>
            Required and unique flags are checked against existing data.
            Configured options cannot be removed while a product family uses
            them.
          </p>
          {!translation && <button disabled={a.busy}>Save definition</button>}{" "}
          <button
            type="button"
            className="secondary"
            onClick={() => navigate(returnPath)}
          >
            Cancel
          </button>
        </Form>;
}

export function AttributeDefinitionEditorPage({ customer = false, permissions = [] }: { customer?: boolean; permissions?: string[] }) {
  const { id } = useParams();
  const [search] = useSearchParams();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const deletion = useAction();
  const cache = useQueryClient();
  useEffect(() => setConfirmDelete(false), [id]);
  const navigate = useNavigate();
  const returnPath = customer ? "/customers/attributes" : "/catalog/attributes";
  const entity = customer ? "customer" : search.get("entity") === "category" ? "category" : "product";
  const q = useQuery({ queryKey: ["attribute-definitions", "editor", customer], queryFn: async () => (await Promise.all((customer ? ["customer"] as const : ["product", "category", "customer"] as const).map(value => attributeApi.list(value)))).flat(), enabled: id !== "new" });
  const has = (permission:string) => permissions.includes("*") || permissions.includes(permission);
  const scope = useEditorLanguage({canRead:has("languages.read"), persisted:id !== "new" && !!q.data, disabled:confirmDelete, sourceBusy:deletion.busy});
  const initial = useMemo(() => id === "new" ? fresh(entity) : q.data?.find(item => item.id === id), [id, entity, q.data]);
  if (!customer && ((id === "new" && search.get("entity") === "customer") || initial?.entity_type === "customer")) return <Navigate replace to={`/customers/attributes/definitions/${id}`} />;
  if (id !== "new" && q.isPending) return <main><p role="status">Loading attribute…</p></main>;
  if (!initial) return <main><PageHeader title={<>Attribute unavailable</>} /><Notice error>{q.error?.message || "Attribute not found"}</Notice><button onClick={() => navigate(returnPath)}>Back to attributes</button></main>;
  return <main className="product-detail-page"><button className="text-button back-link" onClick={() => navigate(returnPath)}>← {customer ? "Customer attributes" : "Attributes"}</button><PageHeader title={<>{id === "new" ? customer ? "New customer attribute" : "New attribute" : initial.label}</>} description={<>{customer ? "Configure customer profile fields, validation, and segment usage." : "Configure validation, catalog behavior, and storefront usage."}</>} actions={<>{scope.toolbar}{id !== "new" && !scope.locale && <button type="button" className="secondary danger" disabled={deletion.busy || scope.dirty || scope.busy} onClick={() => setConfirmDelete(true)}>Delete attribute</button>}</>} />
    {confirmDelete && <section className="set-delete-confirm" role="alert" aria-label="Confirm attribute deletion">
      <span><strong>Delete {initial.label}?</strong><small>This permanently deletes the attribute. Attributes used by existing records or product configurations cannot be deleted.</small></span>
      <div><button type="button" className="secondary" disabled={deletion.busy} onClick={() => setConfirmDelete(false)}>Cancel</button><button type="button" className="danger" disabled={deletion.busy} onClick={() => void deletion.run(async () => {
        await attributeApi.delete(initial.id);
        await Promise.all([
          cache.invalidateQueries({ queryKey: ["attribute-definitions"] }),
          cache.invalidateQueries({ queryKey: ["attribute-sets"] }),
        ]);
        navigate(returnPath, { replace: true });
      })}>{deletion.busy ? "Deleting…" : "Confirm deletion"}</button></div>
    </section>}
    <Notice error>{deletion.error}</Notice>
    {scope.language ? <EntityTranslationEditor key={`${initial.id}-${scope.locale}`} kind="attribute" id={initial.id} language={scope.language} canWrite={has('languages.write') && has('attributes.write')} onStateChange={scope.onEditorStateChange} renderEditor={translation => <AttributeDefinitionForm initial={initial} translation={translation}/>}/> : <AttributeDefinitionForm key={initial.id} initial={initial} onStateChange={scope.onEditorStateChange}/>}</main>;
}

const blankSet = (): AttributeSet => ({ id: crypto.randomUUID(), name: "", description: "", version: 0, members: [] });
function AttributeSetsPanel({ canWrite, editorId }: { canWrite: boolean; editorId?: string }) {
  const navigate = useNavigate();
  const sets = useQuery({ queryKey: ["attribute-sets"], queryFn: attributeApi.sets });
  const definitions = useQuery({ queryKey: ["attribute-definitions", "product"], queryFn: () => attributeApi.list("product") });
  const [form, setForm] = useState<AttributeSet>();
  const [group, setGroup] = useState("General");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const action = useAction();
  const cache = useQueryClient();
  const byId = useMemo(() => new Map(definitions.data?.map((d) => [d.id, d]) ?? []), [definitions.data]);
  const unassigned = definitions.data?.filter((d) => !form?.members.some((m) => m.definition_id === d.id)) ?? [];
  const groups = form ? [...new Set(form.members.map((m) => m.group_name))] : [];
  useEffect(() => {
    if (!editorId) return;
    if (editorId === "new") setForm((current) => current ?? blankSet());
    else if (sets.data) setForm(sets.data.find((item) => item.id === editorId));
  }, [editorId, sets.data]);
  const save = async () => action.run(async () => {
    if (!form) return;
    const saved = await attributeApi.saveSet(form);
    setForm(saved);
    await cache.invalidateQueries({ queryKey: ["attribute-sets"] });
    action.setMessage("Attribute set saved.");
    if (editorId) navigate("/catalog/attributes/sets");
  });
  return (
    <section className="attribute-workspace">
      <div className="attribute-section-head">
        <div><h2>Attribute sets</h2><p>Create templates that arrange product fields into practical editing groups.</p></div>
      </div>
      <Notice error>{sets.error?.message || definitions.error?.message || action.error}</Notice>
      <Notice>{action.message}</Notice>
      <div className={`attribute-set-layout ${editorId ? "standalone-set-layout" : "attribute-set-management"}`}>
        {!editorId && <aside className="attribute-set-list">
          <div className="set-list-label"><span>Sets</span><strong>{sets.data?.length ?? 0}</strong></div>
          {sets.data?.map((set) => (
            <button key={set.id} className={form?.id === set.id ? "selected" : ""} onClick={() => navigate(`/catalog/attributes/sets/${set.id}`)}>
              <span><strong>{set.name}</strong><EntityIdLabel row={set}/><small>{set.members.length} attributes · {new Set(set.members.map((m) => m.group_name)).size} groups</small></span><b>›</b>
            </button>
          ))}
          {!sets.isLoading && !sets.data?.length && <p className="empty-admin">No attribute sets yet.</p>}
        </aside>}
        {editorId && <div className="set-builder">
          {!form ? <div className="set-empty"><span>◫</span><h3>{editorId && sets.isLoading ? "Loading attribute set…" : editorId ? "Attribute set unavailable" : "Select an attribute set"}</h3><p>{editorId && sets.isLoading ? "Loading the latest configuration." : editorId ? "This attribute set does not exist or is no longer available." : "Choose a set to review its groups, or create a new one."}</p></div> : (
            <>
              <div className="set-builder-head">
                <div className="set-fields"><Field label="Set name" required maxLength={120} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}/><Field label="Description" maxLength={500} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })}/></div>
                {canWrite && <div className="set-actions"><button disabled={action.busy || !form.name.trim()} onClick={() => void save()}>Save set</button>{form.version > 0 && <button className="secondary danger" onClick={() => setConfirmDelete(true)}>Delete</button>}</div>}
              </div>
              {confirmDelete && <div className="set-delete-confirm" role="alert"><span><strong>Delete {form.name}?</strong><small>Deletion is blocked while products or the catalog default reference this set.</small></span><div><button className="secondary" onClick={() => setConfirmDelete(false)}>Cancel</button><button className="danger" disabled={action.busy} onClick={() => void action.run(async () => { await attributeApi.deleteSet(form.id); setForm(undefined); setConfirmDelete(false); await cache.invalidateQueries({ queryKey: ["attribute-sets"] }); if (editorId) navigate("/catalog/attributes/sets"); })}>Delete set</button></div></div>}
              <div className="set-columns">
                <section className="set-groups"><div className="set-column-title"><div><h3>Groups</h3><p>Fields appear in this order on the product form.</p></div><div className="new-group"><input aria-label="Group name" value={group} maxLength={80} onChange={(e) => setGroup(e.target.value)}/></div></div>
                  {groups.map((name) => <article key={name}><header><strong>{name}</strong><span>{form.members.filter((m) => m.group_name === name).length}</span></header>{form.members.filter((m) => m.group_name === name).sort((a,b) => a.position-b.position).map((m, index, items) => <div className="set-member" key={m.definition_id}><span><strong>{byId.get(m.definition_id)?.label ?? "Unknown attribute"}</strong><small>{byId.get(m.definition_id)?.attribute_code}</small></span>{canWrite && <div><button className="icon-button" disabled={index === 0} aria-label="Move up" onClick={() => { const previous = items[index-1]; setForm({...form, members: form.members.map((x) => x.definition_id === m.definition_id ? {...x, position: previous.position} : x.definition_id === previous.definition_id ? {...x, position: m.position} : x)}); }}>↑</button><button className="icon-button danger" aria-label="Remove" onClick={() => setForm({...form, members: form.members.filter((x) => x.definition_id !== m.definition_id)})}>×</button></div>}</div>)}</article>)}
                  {!groups.length && <div className="set-drop-hint">Add an attribute from the library to create the first group.</div>}
                </section>
                <aside className="unassigned-library"><div className="set-column-title"><div><h3>Unassigned attributes</h3><p>Add fields to the group named below.</p></div></div>{unassigned.map((d) => <div className="set-member" key={d.id}><span><strong>{d.label}</strong><small>{d.attribute_code} · {d.input_type}</small></span>{canWrite && <button className="secondary add-member" disabled={!group.trim()} onClick={() => { const positions = form.members.filter((m) => m.group_name === group.trim()).map((m) => m.position); setForm({...form, members:[...form.members,{definition_id:d.id,group_name:group.trim(),position:positions.length ? Math.max(...positions)+1 : 0}]}); }}>Add</button>}</div>)}{!unassigned.length && <p className="set-complete">All product attributes are assigned.</p>}</aside>
              </div>
            </>
          )}
        </div>}
      </div>
    </section>
  );
}
export function AttributeSetEditorPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  return <main className="product-detail-page"><button className="text-button back-link" onClick={() => navigate("/catalog/attributes/sets")}>← Attribute sets</button><PageHeader title={<>{id === "new" ? "New attribute set" : "Edit attribute set"}</>} description={<>Arrange product attributes into reusable catalog groups.</>} /><AttributeSetsPanel key={id} canWrite editorId={id}/></main>;
}
export function ProductStructureEditor({ product }: { product: Product }) {
  const q = useQuery({
    queryKey: ["family-admin", product.id],
    queryFn: () => attributeApi.adminFamily(product.id),
  });
  return (
    <details className="form-card">
      <summary>Product type & children</summary>
      <Notice error>{q.error?.message}</Notice>
      {q.data && (
        <StructureForm
          key={product.id}
          product={product}
          initial={q.data.structure}
          initialChildren={q.data.children}
        />
      )}
    </details>
  );
}
function StructureForm({
  product,
  initial,
  initialChildren,
}: {
  product: Product;
  initial: ProductStructure;
  initialChildren: Product[];
}) {
  const [form, setForm] = useState(initial),
    [search, setSearch] = useState(""),
    [known, setKnown] = useState(initialChildren),
    a = useAction(),
    cache = useQueryClient();
  const defs = useQuery({
    queryKey: ["attribute-definitions", "product"],
    queryFn: () => attributeApi.list("product"),
  });
  const results = useQuery({
    queryKey: ["child-picker", search],
    queryFn: () =>
      operationsApi.products({
        q: search,
        category_id: null,
        active: null,
        offset: 0,
      }),
    enabled: search.length > 1,
  });
  return (
    <section>
      <p>
        Save simple child SKUs and their option values first, then link them
        here. Grouped products sell each child separately. Bundles require one
        choice per group and charge the selected SKU prices.
      </p>
      <Notice error>{a.error || results.error?.message}</Notice>
      <Notice>{a.message}</Notice>
      <label className="field">
        Product type
        <select
          value={form.product_type}
          onChange={(e) =>
            setForm({
              ...form,
              product_type: e.target.value as ProductStructure["product_type"],
              configurable_attributes: [],
              children: [],
            })
          }
        >
          <option>simple</option>
          <option>configurable</option>
          <option>grouped</option>
          <option>bundle</option>
        </select>
      </label>
      {form.product_type === "configurable" && (
        <fieldset>
          <legend>Variant attributes (up to 3)</legend>
          {defs.data
            ?.filter((d) => d.used_for_configurations)
            .map((d) => (
              <label className="check" key={d.id}>
                <input
                  type="checkbox"
                  checked={form.configurable_attributes.includes(
                    d.attribute_code,
                  )}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      configurable_attributes: e.target.checked
                        ? [...form.configurable_attributes, d.attribute_code]
                        : form.configurable_attributes.filter(
                            (c) => c !== d.attribute_code,
                          ),
                    })
                  }
                />
                {d.label}
              </label>
            ))}
        </fieldset>
      )}
      {form.product_type !== "simple" && (
        <>
          <Field
            label="Find child by name or SKU"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {results.data?.items
            .filter(
              (p) =>
                p.id !== product.id &&
                p.product_type === "simple" &&
                !form.children.some((l) => l.child_id === p.id),
            )
            .slice(0, 20)
            .map((p) => (
              <p key={p.id}>
                {p.name} · {p.sku}{" "}
                <button
                  onClick={() => {
                    setForm({
                      ...form,
                      children: [
                        ...form.children,
                        { child_id: p.id, option_label: "", quantity: 1 },
                      ],
                    });
                    setKnown([...known, p]);
                  }}
                >
                  Add child
                </button>
              </p>
            ))}
          <ol>
            {form.children.map((l, i) => (
              <li key={l.child_id}>
                {known.find((p) => p.id === l.child_id)?.name ?? l.child_id}
                {form.product_type === "bundle" && (
                  <>
                    <Field
                      label={`Choice group ${i + 1}`}
                      value={l.option_label}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          children: form.children.map((v, n) =>
                            n === i
                              ? { ...v, option_label: e.target.value }
                              : v,
                          ),
                        })
                      }
                    />
                    <Field
                      label={`Included quantity ${i + 1}`}
                      type="number"
                      min="1"
                      max="999"
                      value={l.quantity}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          children: form.children.map((v, n) =>
                            n === i
                              ? { ...v, quantity: Number(e.target.value) }
                              : v,
                          ),
                        })
                      }
                    />
                  </>
                )}{" "}
                <button
                  className="text-button"
                  onClick={() =>
                    setForm({
                      ...form,
                      children: form.children.filter((_, n) => n !== i),
                    })
                  }
                >
                  Remove child
                </button>
              </li>
            ))}
          </ol>
        </>
      )}
      <button
        disabled={a.busy}
        onClick={() =>
          a.run(async () => {
            await attributeApi.structure(product.id, form);
            await cache.invalidateQueries({
              queryKey: ["family-admin", product.id],
            });
            await cache.invalidateQueries({
              queryKey: ["operations-products"],
            });
            a.setMessage(
              "Product structure saved. Storefront indexing is automatic.",
            );
          })
        }
      >
        Save product structure
      </button>
    </section>
  );
}
export function CategoryAttributeEditor({ id, onStateChange, translation }: { id: string; translation?: TranslationEditorFields; onStateChange?: (state: {dirty:boolean;busy:boolean}) => void }) {
  const queryClient = useQueryClient();
  const defs = useQuery({
    queryKey: ["attribute-definitions", "category"],
    queryFn: () => attributeApi.list("category"),
  });
  const q = useQuery({
    queryKey: ["category-values", id],
    queryFn: () => attributeApi.category(id),
  });
  const media = useQuery({
    queryKey: ["catalog", "media"],
    queryFn: catalogApi.mediaList,
  });
  const [values, setValues] = useState<Record<string, unknown>>(),
    a = useAction();
  const dirty=values!==undefined && JSON.stringify(values)!==JSON.stringify(q.data??{});
  useLayoutEffect(()=>{onStateChange?.({dirty,busy:a.busy});},[dirty,a.busy,onStateChange]);
  return (
    <details className="form-card" open>
      <summary>Category attributes</summary>
      <p className="help">Choose images from the media library. Thumbnail appears in category links; Banner appears at the top of the category screen.</p>
      <Notice error>
        {q.error?.message || defs.error?.message || media.error?.message || a.error}
      </Notice>
      <Notice>{a.message}</Notice>
      {translation && Object.keys(translation.source).filter(key=>key.startsWith('attribute.')).map(key=>translation.field(key))}
      {(!translation || defs.data?.some(d=>!(`attribute.${d.attribute_code}` in translation.source))) && <fieldset disabled={!!translation}><AttributeFields
        definitions={(defs.data ?? []).filter(d=>!translation || !(`attribute.${d.attribute_code}` in translation.source))}
        values={values ?? q.data ?? {}}
        onChange={setValues}
        media={media.data}
        imageUrl={mediaUrl}
        mediaLoading={media.isPending}
      /></fieldset>}
      {!translation && <button
        disabled={a.busy || !q.data}
        onClick={() =>
          a.run(async () => {
            await attributeApi.saveCategory(id, values ?? q.data ?? {});
            await queryClient.invalidateQueries({ queryKey: ["category-values", id] });
            await queryClient.invalidateQueries({ queryKey: ["catalog", "categories"] });
            a.setMessage("Category attributes saved.");
          })
        }
      >
        Save category attributes
      </button>}
    </details>
  );
}
export function PromotionAttributeConditions({ id }: { id: string }) {
  const defs = useQuery({
      queryKey: ["attribute-definitions", "product"],
      queryFn: () => attributeApi.list("product"),
    }),
    q = useQuery({
      queryKey: ["promotion-attributes", id],
      queryFn: () => attributeApi.promo(id),
    }),
    [values, setValues] = useState<Record<string, unknown>>(),
    a = useAction();
  return (
    <section className="form-card">
      <h3>Product attribute conditions</h3>
      <p>
        All specified conditions must match. Multiselect attributes match when
        they contain the selected value. Blank fields impose no condition.
      </p>
      <Notice error>
        {defs.error?.message || q.error?.message || a.error}
      </Notice>
      <Notice>{a.message}</Notice>
      <AttributeFields
        definitions={(defs.data ?? [])
          .filter((d) => d.used_for_promo_rules)
          .map((d) => ({
            ...d,
            is_required: false,
            input_type:
              d.input_type === "multiselect" ? "select" : d.input_type,
          }))}
        values={values ?? q.data ?? {}}
        onChange={setValues}
      />
      <button
        disabled={a.busy || !q.data}
        onClick={() =>
          a.run(async () => {
            await attributeApi.savePromo(id, values ?? q.data ?? {});
            a.setMessage("Attribute conditions saved.");
          })
        }
      >
        Save attribute conditions
      </button>
    </section>
  );
}

function AttributeMetadataEditor({definition,value,onChange,hideDescription=false}:{hideDescription?:boolean;definition:AttributeDefinition;value:AttributeMetadata;onChange:(v:AttributeMetadata)=>void}) {
 const update=<K extends keyof AttributeMetadata>(key:K,next:AttributeMetadata[K])=>onChange({...value,[key]:next});
 return <fieldset><legend>{definition.entity_type === "customer" ? "Attribute settings" : "Catalog and AI behavior"}</legend>{!hideDescription && <Field label="Description" value={value.description??''} maxLength={2000} onChange={e=>update('description',e.target.value)}/>}<div className="form-grid"><label className="field">Status<select value={value.status??'active'} onChange={e=>update('status',e.target.value as AttributeMetadata['status'])}><option value="active">Active</option><option value="disabled">Disabled (preserve existing values)</option></select></label><label className="field">Source policy<select value={value.source_policy??'factual'} onChange={e=>onChange({...value,source_policy:e.target.value as AttributeMetadata['source_policy'],ai_enrichable:false})}><option value="factual">Factual · merchant/imported/verified</option><option value="semantic">Semantic · reviewed inference allowed</option><option value="trusted_only">Trusted only · inference forbidden</option></select></label><label className="field">Semantic role<select value={value.semantic_role??''} onChange={e=>update('semantic_role',(e.target.value||null) as AttributeMetadata['semantic_role'])}><option value="">General attribute</option><option value="classification">Product classification</option><option value="brand">Brand</option><option value="intended_use">Intended use</option></select></label><Field label="Unit (required for measurement)" value={value.unit??''} maxLength={30} onChange={e=>update('unit',e.target.value||null)}/><Field label="Display order" type="number" min={0} value={value.display_order??0} onChange={e=>update('display_order',Number(e.target.value))}/>{(['min','max','max_length'] as const).map(k=><Field key={k} label={k==='min'?'Minimum value':k==='max'?'Maximum value':'Maximum text length'} type="number" step={k==='max_length'?'1':'any'} value={value[k]??''} onChange={e=>update(k,e.target.value===''?null:Number(e.target.value))}/>)}</div>{([['admin_visible','Visible in admin'],['facetable','Facetable (requires filterable)'],['sortable','Sortable (numeric/date fields)'],['ai_queryable','AI queryable'],['ai_enrichable','AI enrichable (reviewed semantic suggestions only)']] as const).map(([key,label])=><label className="check" key={key}><input type="checkbox" disabled={key==='ai_enrichable'&&value.source_policy!=='semantic'} checked={value[key]??(key==='admin_visible')} onChange={e=>update(key,e.target.checked)}/>{label}</label>)}<h3>Default for new {definition.entity_type === "customer" ? "customers" : "products"}</h3><AttributeFields definitions={[{...definition,label:'Default value',is_required:false,metadata:{...value,status:'active',admin_visible:true}}]} values={value.default_value==null?{}:{[definition.attribute_code]:value.default_value}} onChange={v=>update('default_value',v[definition.attribute_code]??null)}/><p className="help">Trusted-only policies cannot be weakened. Types and codes are immutable after creation; changes are checked against existing catalog values.</p></fieldset>;
}
