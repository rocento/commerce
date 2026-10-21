import { EntityIdHeading, EntityIdCell } from "./entity-id";
import { createMissingStarterAttributes, supportsCustomerSegments } from './customer-attribute-policy';
import { RowActions } from "./row-actions";
import { PageHeader } from "./page-header";
import { GridToolbar } from "./grid-controls";
import { attributeApi, segmentsApi, type AttributeDefinition, type CustomerSegment, type CustomerSegmentInput, type SegmentRule, type SegmentField } from "@commerce/api-client";
import { Field, Notice, useAction } from "@commerce/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";

const emptySegment = (): CustomerSegmentInput => ({
  name: "", description: "", status: "inactive", website: "Main Website", applyTo: "registered", match: "all", revision: 0,
  rules: [{ id: crypto.randomUUID(), type: "customer", attribute: "customer_group", operator: "is", value: "general" }],
});

export function CustomerSegments({ canWrite }: { canWrite: boolean }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const [offset, setOffset] = useState(0);
  const list = useQuery({ queryKey: ["customer-segments", offset], queryFn: () => segmentsApi.list(offset), enabled: !id });
  const total = useQuery({ queryKey: ["customer-segments", "count"], queryFn: () => segmentsApi.count(), enabled: !id });
  const detail = useQuery({ queryKey: ["customer-segment", id], queryFn: () => segmentsApi.get(id!), enabled: !!id && id !== "new" });
  if (id) {
    if (id !== "new" && !detail.data) return <main><PageHeader title={<>Customer Segment</>} /><Notice error>{detail.error?.message}</Notice>{detail.isPending ? <p>Loading segment…</p> : <button onClick={() => void detail.refetch()}>Retry</button>}<button onClick={() => navigate('/customers/segments')}>Back to segments</button></main>;
    return <CustomerSegmentDetail key={`${id}:${detail.data?.revision ?? 0}`} canWrite={canWrite} segment={detail.data} onBack={() => navigate('/customers/segments')} />;
  }
  return <main className="catalog-admin">
    <PageHeader title={<>Customer Segments</>} description={<>Saved audiences with membership calculated from current customer, completed order and saved cart data.</>} actions={<>{canWrite && <button onClick={() => navigate('/customers/segments/new')}>Add Segment</button>}</>} />
    <p>Counts are evaluated when loaded. Audiences can overlap; counts should not be added together. Visitor tracking and promotion/content targeting are not connected.</p>
    <Notice error>{list.error?.message}</Notice>
    <GridToolbar name="customer segments" onSearch={() => {}} chips={[]} clearFilters={() => {}}
      sort="updated_at" sorts={[]} onSort={() => {}} descending onDirection={() => {}}
      limit={50} pageSizes={[50]} onLimit={() => {}} page={offset/50+1} count={list.data?.length ?? 0} total={total.data}
      busy={list.isFetching} error={list.error?.message} refresh={() => { void list.refetch(); void total.refetch(); }}
      first={() => setOffset(0)} previous={() => setOffset(Math.max(0,offset-50))} next={() => setOffset(offset+50)}
      canPrevious={offset>0} canNext={list.data?.length === 50}/>
    {list.isPending ? <p>Loading segments…</p> : <div className="table-wrap"><table><thead><tr><EntityIdHeading/><th>Segment</th><th>Status</th><th>Conditions</th><th>Matched customers</th><th>Evaluated</th><th>Actions</th></tr></thead><tbody>{list.data?.map(segment => <tr key={segment.id}><EntityIdCell row={segment}/>
      <td><button className="text-button" onClick={() => navigate(`/customers/segments/${segment.id}`)}>{segment.name}</button><small className="attribute-code">{segment.description}</small></td>
      <td>{segment.status}</td><td>{segment.rules.length}</td><td>{segment.matchedCustomers.toLocaleString()}</td><td>{new Date(segment.evaluatedAt).toLocaleString()}</td><td><RowActions label={segment.name} items={[{label:canWrite?"Edit segment":"View segment",to:`/customers/segments/${segment.id}`}]} /></td>
    </tr>)}</tbody></table>{list.data?.length === 0 && <p>No saved segments on this page.</p>}</div>}

  </main>;
}

function inputFrom(segment?: CustomerSegment): CustomerSegmentInput {
  if (!segment) return emptySegment();
  const { name, description, status, website, applyTo, match, rules, revision } = segment;
  return { name, description, status, website, applyTo, match, rules, revision };
}

function CustomerSegmentDetail({ canWrite, segment, onBack }: { canWrite: boolean; segment?: CustomerSegment; onBack: () => void }) {
  const [form, setForm] = useState(() => inputFrom(segment));
  const [section, setSection] = useState('properties');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState('');
  const fields = useQuery({ queryKey: ['segment-fields'], queryFn: segmentsApi.fields });
  const action = useAction();
  const cache = useQueryClient();
  const navigate = useNavigate();
  const save = () => void action.run(async () => {
    const saved = await segmentsApi.save(form, segment?.id);
    cache.setQueryData(['customer-segment', saved.id], saved);
    await cache.invalidateQueries({ queryKey: ['customer-segments'] });
    navigate(`/customers/segments/${saved.id}`);
  });
  const remove = () => void action.run(async () => {
    if (!segment) return;
    await segmentsApi.delete(segment.id, segment.revision);
    await cache.invalidateQueries({ queryKey: ['customer-segments'] }); onBack();
  });
  const importDraft = () => {
    try {
      const value: unknown = JSON.parse(importText);
      if (!value || typeof value !== 'object' || !('name' in value) || !('rules' in value) || !Array.isArray(value.rules)) throw new Error('Paste one segment definition with a name and rules.');
      const legacy = value as CustomerSegmentInput;
      const available = fields.data ?? [];
      if (!legacy.rules.every(r => available.some(f => f.family === r.type && f.attribute === r.attribute && f.operators.includes(r.operator)) && typeof r.value === 'string')) throw new Error('This draft has unsupported conditions. Remove or replace them before importing.');
      setForm({ ...emptySegment(), name: String(legacy.name), description: String(legacy.description ?? ''), rules: legacy.rules.map(r => ({...r, id: crypto.randomUUID()})) });
      setImportError(''); setSection('conditions');
    } catch (error) { setImportError(error instanceof Error ? error.message : 'Invalid draft'); }
  };
  return <main className="product-detail-page customer-segment-detail">
    <button className="text-button back-link" onClick={onBack}>← Customer Segments</button>
    <PageHeader title={<>{form.name || 'New Customer Segment'}</>} description={<>Save conditions and view membership from current store data.</>} actions={<>{canWrite && <button disabled={action.busy || !form.name.trim() || !form.rules.length || !fields.data} onClick={save}>Save Segment</button>}</>} />
    <Notice error>{action.error || fields.error?.message}</Notice>
    <div className="order-detail-layout"><aside className="order-subnav" aria-label="Segment sections">{[['properties','Properties'],['conditions','Conditions'],['customers','Matched Customers'],['usage','Usage']].map(([key,label]) => <button key={key} className={section === key ? 'active' : ''} onClick={() => setSection(key)}>{label}</button>)}</aside>
      <section className="order-section-content">
        {section === 'properties' && <section className="form-card"><h2>General Properties</h2><fieldset disabled={!canWrite || action.busy}><div className="form-grid">
          <Field label="Segment name" required value={form.name} onChange={e => setForm({...form,name:e.target.value})}/>
          <label className="field">Status<select value={form.status} onChange={e => setForm({...form,status:e.target.value as CustomerSegmentInput['status']})}><option value="inactive">Inactive</option><option value="active">Active</option></select></label>
          <Field label="Apply to" readOnly value="Registered customers"/>
          </div><label className="field">Description<textarea value={form.description} onChange={e => setForm({...form,description:e.target.value})}/></label></fieldset>
          {segment && canWrite && <div>{confirmDelete ? <><p>Delete this saved segment?</p><button className="danger" disabled={action.busy} onClick={remove}>Confirm delete</button><button className="secondary" onClick={() => setConfirmDelete(false)}>Keep segment</button></> : <button className="secondary danger" onClick={() => setConfirmDelete(true)}>Delete Segment</button>}</div>}
          {!segment && canWrite && <details><summary>Import a previous browser draft</summary><p>Old local drafts remain in this browser's storage. Paste one exported JSON definition here to review it. Sample counts and targeting settings are ignored; nothing is saved until you choose Save Segment.</p><textarea aria-label="Previous segment JSON" value={importText} onChange={e => setImportText(e.target.value)}/><Notice error>{importError}</Notice><button className="secondary" disabled={!fields.data} onClick={importDraft}>Review imported draft</button></details>}
        </section>}
        {section === 'conditions' && <section className="form-card"><h2>Conditions</h2><p>Order rules use delivered or cash-collected orders. Cart rules use saved quantities/prices, including items whose reservations have expired. Custom scalar attributes use exact text comparisons. Missing values do not match, including negative comparisons.</p><fieldset disabled={!canWrite || action.busy}>
          <label className="field">Match<select value={form.match} onChange={e => setForm({...form,match:e.target.value as 'all'|'any'})}><option value="all">All conditions</option><option value="any">Any condition</option></select></label>
          <div className="segment-rule-list">{form.rules.map(rule => <SegmentRuleRow key={rule.id} rule={rule} fields={fields.data ?? []} onChange={next => setForm({...form,rules:form.rules.map(r => r.id === rule.id ? next : r)})} onRemove={() => setForm({...form,rules:form.rules.filter(r => r.id !== rule.id)})}/>)}</div>
          <button className="secondary" disabled={form.rules.length >= 20} onClick={() => setForm({...form,rules:[...form.rules,emptySegment().rules[0]]})}>Add Condition</button>
        </fieldset><p>Address, anonymous visitor, browsing-history, newsletter and store-credit rules are not supported yet.</p></section>}
        {section === 'customers' && <section className="form-card"><h2>Matched Customers</h2>{segment ? <><p><strong>{segment.matchedCustomers.toLocaleString()}</strong> customers match the saved revision {segment.revision}.</p><p>Evaluated {new Date(segment.evaluatedAt).toLocaleString()}. Unsaved changes are not included.</p><button className="secondary" onClick={() => void cache.invalidateQueries({queryKey:['customer-segment',segment.id]})}>Refresh counts</button></> : <p>Save this segment to calculate membership.</p>}</section>}
        {section === 'usage' && <section className="form-card"><h2>Usage</h2><p>These definitions provide audience counts. Promotion targeting, dynamic content and membership export are not connected yet. Active/inactive is a management flag and does not change the count.</p><ul>{form.rules.map(r => <li key={r.id}>{r.type}: {r.attribute} {r.operator} {r.value}</li>)}</ul></section>}
      </section>
    </div>
  </main>;
}

function SegmentRuleRow({ rule, fields, onChange, onRemove }: { rule: SegmentRule; fields: SegmentField[]; onChange: (r:SegmentRule) => void; onRemove: () => void }) {
  const families = [...new Set(fields.map(f => f.family))];
  const options = fields.filter(f => f.family === rule.type);
  const selected = options.find(f => f.attribute === rule.attribute);
  const choose = (field:SegmentField) => onChange({...rule,type:field.family,attribute:field.attribute,operator:field.operators[0]});
  return <div className="segment-rule-row"><label className="field">Condition type<select value={rule.type} onChange={e => {const first=fields.find(f => f.family===e.target.value); if(first)choose(first);}}>{families.map(f => <option key={f} value={f}>{f}</option>)}</select></label>
    <label className="field">Attribute<select value={rule.attribute} onChange={e => {const f=options.find(f=>f.attribute===e.target.value); if(f)choose(f);}}>{!selected && <option value={rule.attribute}>{rule.attribute} (unavailable)</option>}{options.map(f=><option key={f.attribute}>{f.attribute}</option>)}</select></label>
    <label className="field">Operator<select value={rule.operator} onChange={e=>onChange({...rule,operator:e.target.value})}>{selected?.operators.map(op=><option key={op}>{op}</option>)}</select></label>
    <Field label="Value" value={rule.value} onChange={e=>onChange({...rule,value:e.target.value})}/><button className="secondary danger" onClick={onRemove}>Remove</button>
  </div>;
}

export function CustomerAttributes({ canWrite }: { canWrite: boolean }) {
  const navigate = useNavigate();
  const cache = useQueryClient();
  const action = useAction();
  const q = useQuery({
    queryKey: ["attribute-definitions", "customer"],
    queryFn: () => attributeApi.list("customer"),
  });
  const segmentReady = q.data?.filter((item) => item.used_for_promo_rules && supportsCustomerSegments(item.input_type)).length ?? 0;

  return (
    <main className="catalog-admin">
      <PageHeader title={<>Customer Attributes</>} description={<>
            Add custom fields for account information, address workflows,
            customer management, and segment conditions.
          </>} actions={<>{canWrite && (
          <button
            onClick={() =>
              navigate("/customers/attributes/definitions/new")
            }
          >
            Add Attribute
          </button>
        )}</>} />
      <section className="metric-grid customer-segment-metrics">
        <article>
          <span>Total attributes</span>
          <strong>{q.data?.length ?? 0}</strong>
          <small>Customer entity fields</small>
        </article>
        <article>
          <span>Required</span>
          <strong>{q.data?.filter((item) => item.is_required).length ?? 0}</strong>
          <small>Needed on profile forms</small>
        </article>
        <article>
          <span>Unique</span>
          <strong>{q.data?.filter((item) => item.is_unique).length ?? 0}</strong>
          <small>Validated across customers</small>
        </article>
        <article>
          <span>Use in segments</span>
          <strong>{segmentReady}</strong>
          <small>Available as rule fields</small>
        </article>
      </section>
      <Notice error>{q.error?.message || action.error}</Notice>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <EntityIdHeading/><th>Attribute</th>
              <th>Input type</th>
              <th>Forms</th>
              <th>Properties</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {q.data?.map((attribute) => (
              <tr key={attribute.id}><EntityIdCell row={attribute}/>
                <td>
                  <strong>{attribute.label}</strong>
                  <small className="attribute-code">
                    {attribute.attribute_code}
                  </small>
                </td>
                <td>
                  <span className="badge">{attribute.input_type}</span>
                </td>
                <td>Account Information · Address Book · Billing Information</td>
                <td>
                  {[
                    attribute.is_required && "Required",
                    attribute.is_unique && "Unique",
                    attribute.used_for_promo_rules && supportsCustomerSegments(attribute.input_type) && "Use in segments",
                  ]
                    .filter(Boolean)
                    .join(" · ") || "Optional"}
                </td>
                <td>
                  {canWrite && (
                    <RowActions label={attribute.label} items={[{label:"Edit",to:`/customers/attributes/definitions/${attribute.id}`}]} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {canWrite && q.data && ["loyalty_tier", "preferred_channel"].some(code => !q.data.some(item => item.attribute_code === code)) && (
        <section className="panel">
          <h2>Suggested starter attributes</h2>
          <p>
            Create fields like loyalty tier, preferred channel, customer type,
            tax ID, or birthday opt-in, then enable them for customer segment
            conditions when they should drive personalization.
          </p>
          <button
            className="secondary"
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                try {
                  await createMissingStarterAttributes([starterAttribute("loyalty_tier", "Loyalty Tier", "select"), starterAttribute("preferred_channel", "Preferred Channel", "select")], () => attributeApi.list("customer"), item => attributeApi.save(item));
                } finally {
                  await cache.invalidateQueries({ queryKey: ["attribute-definitions"] });
                }
                action.setMessage("Starter customer attributes created.");
              })
            }
          >
            Create Starter Attributes
          </button>
        </section>
      )}
    </main>
  );
}

function starterAttribute(
  code: string,
  label: string,
  inputType: AttributeDefinition["input_type"],
): AttributeDefinition {
  return {
    id: crypto.randomUUID(),
    entity_type: "customer",
    attribute_code: code,
    label,
    input_type: inputType,
    scope: "global",
    options:
      code === "loyalty_tier"
        ? [
            { value: "bronze", label: "Bronze" },
            { value: "silver", label: "Silver" },
            { value: "gold", label: "Gold" },
          ]
        : [
            { value: "email", label: "Email" },
            { value: "sms", label: "SMS" },
            { value: "whatsapp", label: "WhatsApp" },
          ],
    swatch_type: "none",
    version: 0,
    is_required: false,
    is_unique: false,
    is_searchable: false,
    is_filterable: false,
    is_comparable: false,
    is_visible_on_front: false,
    used_for_promo_rules: true,
    used_for_configurations: false,
  };
}
