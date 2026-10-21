import { useEffect, useRef, useState } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { catalogApi, catalogSchemaApi, attributeApi, operationsApi, type AttributeDefinition } from '@commerce/api-client';
import { Notice, useAction } from '@commerce/ui';
import { PageHeader } from './page-header';
import { RowActions } from './row-actions';
import { DiscoveryCoverage } from './discovery-coverage';
import './catalog-enrichment.css';

type Suggestion = Awaited<ReturnType<typeof catalogSchemaApi.suggestions>>[number];
type Status = 'pending' | 'approved' | 'rejected' | '';
const PAGE_SIZE = 50;
const PRODUCT_PAGE_SIZE = 100;
const supportedTypes = new Set(['text', 'textarea', 'long_text', 'select', 'single_select', 'multiselect', 'multi_select']);

export function enrichmentEligible(d: AttributeDefinition) {
 return d.metadata?.ai_enrichable && d.metadata.source_policy === 'semantic' && (d.metadata.status ?? 'active') === 'active' && !d.used_for_configurations && supportedTypes.has(d.input_type);
}

export function enrichmentValue(value: unknown, definition?: AttributeDefinition): string {
 if (Array.isArray(value)) return value.map(item => enrichmentValue(item, definition)).join(', ');
 const option = definition?.options.find(option => option.value === value);
 return option?.label ?? (typeof value === 'string' ? value : JSON.stringify(value) ?? '—');
}

export function EnrichmentEvidence({ suggestion }: { suggestion: Suggestion }) {
 return <div className="enrichment-evidence">
  <div className="enrichment-evidence-heading"><strong>{suggestion.source === 'DERIVED' ? 'Description extraction' : 'AI proposal'}</strong><span>{Math.round(suggestion.confidence * 100)}% confidence</span></div>
  {suggestion.evidence ? <><small>Source: {suggestion.evidence.field}</small><blockquote>{suggestion.evidence.quote}</blockquote></> : <p className="enrichment-warning">Source evidence missing. Reject this legacy suggestion and generate a new one.</p>}
  <small>Confidence does not verify the product claim. Check the source before approval.</small>
  <details><summary>Generation details</summary><small>{suggestion.model_version} · {suggestion.source}</small></details>
 </div>;
}

function ReviewDialog({ suggestion, approve, definition, productName, onClose, onSaved }: {
 suggestion: Suggestion; approve: boolean; definition?: AttributeDefinition; productName: string;
 onClose: () => void; onSaved: (message: string) => Promise<void>;
}) {
 const dialog = useRef<HTMLDialogElement>(null), lock = useRef(false), action = useAction();
 useEffect(() => { const node = dialog.current!; node.showModal(); return () => node.close(); }, []);
 async function confirm() {
  if (lock.current) return;
  lock.current = true;
  await action.run(async () => {
   await catalogSchemaApi.review(suggestion.id, approve);
   await onSaved(approve ? 'Suggestion approved and product updated.' : 'Suggestion rejected.');
  });
  lock.current = false;
 }
 return <dialog ref={dialog} className="enrichment-dialog" aria-labelledby="enrichment-review-title" onCancel={event => { event.preventDefault(); if (!lock.current) onClose(); }}>
  <span className="enrichment-eyebrow">Review suggestion</span><h2 id="enrichment-review-title">{approve ? 'Approve' : 'Reject'} this suggestion?</h2>
  <p>{productName}</p><div className="enrichment-proposed"><small>{definition?.label ?? 'Proposed attribute'}</small><strong>{enrichmentValue(suggestion.value, definition)}</strong></div>
  <EnrichmentEvidence suggestion={suggestion}/>
  <p>{approve ? 'Approval adds this value to the product. The source and current value are checked again before saving.' : 'The proposal will be rejected without changing the product. Generating again from the same description will keep this decision.'}</p>
  <Notice error>{action.error}</Notice>
  <footer><button className="secondary" autoFocus disabled={action.busy} onClick={onClose}>Cancel</button><button disabled={action.busy} onClick={() => void confirm()}>{action.busy ? 'Saving…' : 'Confirm review'}</button></footer>
 </dialog>;
}

export function CatalogEnrichment({ canWrite, canReadCatalog = true, canManageDiscovery = canWrite }: { canWrite: boolean; canReadCatalog?: boolean; canManageDiscovery?: boolean }) {
 return <main className="catalog-enrichment">
  <PageHeader title="Catalog enrichment" description="Improve product attributes, review AI coverage and manage discovery ranking." actions={<><Link className="secondary" to="/system/configuration/industry">Catalog setup</Link>{canReadCatalog && <Link className="secondary" to="/catalog/attributes">Configure attributes</Link>}</>}/>
  {canReadCatalog && <EnrichmentSuggestions canWrite={canWrite}/>}
  <DiscoveryCoverage canWrite={canManageDiscovery} canReadCatalog={canReadCatalog}/>
 </main>;
}

function EnrichmentSuggestions({ canWrite }: { canWrite: boolean }) {
 const cache = useQueryClient(), action = useAction(), generationLock = useRef(false);
 const [status, setStatus] = useState<Status>('pending');
 const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
 const [productFilter, setProductFilter] = useState<string>();
 const [review, setReview] = useState<{ suggestion: Suggestion; approve: boolean } | null>(null);
 const [search, setSearch] = useState(''), [term, setTerm] = useState(''), [offset, setOffset] = useState(0), [selected, setSelected] = useState('');
 const before = cursors[cursors.length - 1];
 const query = useQuery({ queryKey: ['catalog-enrichment', status, before, productFilter], queryFn: () => catalogSchemaApi.suggestions({ status: status || undefined, before, product_id: productFilter, limit: PAGE_SIZE }) });
 const definitions = useQuery({ queryKey: ['attribute-definitions', 'product'], queryFn: () => attributeApi.list('product') });
 const sets = useQuery({ queryKey: ['attribute-sets'], queryFn: attributeApi.sets, enabled: canWrite });
 const products = useQuery({ queryKey: ['enrichment-products', term, offset], queryFn: () => operationsApi.products({ q: term, offset, category_id: null, active: null }), enabled: canWrite });
 const rows = query.data ?? [];
 // Share one detail request per product, including inactive demo products and read-only queues.
 const productIds = [...new Set([...rows.map(s => s.product_id), ...(selected ? [selected] : []), ...(productFilter ? [productFilter] : [])])];
 const details = useQueries({ queries: productIds.map(id => ({ queryKey: ['catalog', 'enrichment-product', id], queryFn: () => catalogApi.adminProduct(id), staleTime: 60_000, retry: false })) });
 const productDetails = new Map(productIds.map((id, index) => [id, details[index]]));
 const selectedQuery = productDetails.get(selected), selectedProduct = selectedQuery?.data;
 const selectedSet = sets.data?.find(set => set.id === selectedProduct?.attribute_set_id);
 const eligible = definitions.data?.filter(enrichmentEligible) ?? [];
 const available = selectedProduct ? eligible.filter(d => (!selectedProduct.attribute_set_id || selectedSet?.members.some(m => m.definition_id === d.id)) && !Object.prototype.hasOwnProperty.call(selectedProduct.attributes, d.attribute_code)) : [];
 const ready = !!selectedProduct && !definitions.isPending && !definitions.error && (!selectedProduct.attribute_set_id || !!selectedSet) && available.length > 0;
 async function refresh() {
  await Promise.all([
   cache.invalidateQueries({ queryKey: ['catalog-enrichment'] }),
   cache.invalidateQueries({ queryKey: ['catalog'] }),
   cache.invalidateQueries({ queryKey: ['catalog-discovery'] }),
   cache.invalidateQueries({ queryKey: ['enrichment-products'] }),
  ]);
 }
 async function generate() {
  if (!ready || generationLock.current) return;
  generationLock.current = true;
  await action.run(async () => {
   const result = await catalogSchemaApi.generateEnrichment(selected);
   setProductFilter(selected); setStatus('pending'); setCursors([undefined]); setReview(null);
   await refresh();
   const pending = result.filter(s => s.status === 'pending').length;
   action.setMessage(result.length ? `${pending} pending suggestion${pending === 1 ? '' : 's'} available. ${result.length - pending} previously reviewed. Repeated suggestions keep their earlier review decisions.` : 'No suggestions found. Add explicit labelled description lines for the missing attributes shown above, then try again.');
  });
  generationLock.current = false;
 }
 return <div className="enrichment-suggestions">
  <Notice error>{action.error}</Notice><Notice>{action.message}</Notice>
  <div className="enrichment-setup">
   <section className="enrichment-panel" aria-labelledby="enrichment-generate-title">
    <div className="enrichment-section-heading"><div><span className="enrichment-eyebrow">Step 1 · Prepare</span><h2 id="enrichment-generate-title">Generate suggestions</h2></div><span className="badge">{definitions.isPending ? 'Loading attributes…' : `${eligible.length} eligible attributes`}</span></div>
    <p>Choose a product to extract missing text and choice attributes from its description. Existing values are preserved.</p>
    <Notice error>{definitions.error?.message || sets.error?.message || products.error?.message}</Notice>
    {canWrite ? <>
     <form className="enrichment-search" onSubmit={event => { event.preventDefault(); setTerm(search.trim()); setOffset(0); setSelected(''); }}>
      <label className="field">Find a product<input value={search} maxLength={200} disabled={action.busy} onChange={event => setSearch(event.target.value)} placeholder="Search by product name or SKU"/></label>
      <button className="secondary" disabled={products.isFetching || action.busy}>Search</button>
     </form>
     <label className="field">Product<select value={selected} disabled={products.isFetching || action.busy} onChange={event => setSelected(event.target.value)}><option value="">Choose a product</option>{products.data?.items.map(p => <option key={p.id} value={p.id}>{p.name} · {p.sku}</option>)}</select></label>
     {products.isFetching && <p role="status">Loading products…</p>}
     {products.data?.items.length === 0 && <p>No products match this search. Try another name or SKU.</p>}
     {!!products.data?.total && <div className="enrichment-product-pagination"><small>{offset + 1}–{offset + products.data.items.length} of {products.data.total} products</small>{products.data.total > PRODUCT_PAGE_SIZE && <div><button className="secondary" disabled={offset === 0 || products.isFetching || action.busy} onClick={() => { setOffset(Math.max(0, offset - PRODUCT_PAGE_SIZE)); setSelected(''); }}>Previous products</button><button className="secondary" disabled={offset + products.data.items.length >= products.data.total || products.isFetching || action.busy} onClick={() => { setOffset(offset + PRODUCT_PAGE_SIZE); setSelected(''); }}>Next products</button></div>}</div>}
     {selectedQuery?.isPending && <p role="status">Checking product attributes…</p>}
     {selectedQuery?.error && <Notice error>Product details could not be loaded. <button className="text-button" onClick={() => void selectedQuery.refetch()}>Retry</button></Notice>}
     {selectedProduct && <div className="enrichment-product-preview"><div><strong>{selectedProduct.name}</strong><Link to={`/catalog/products/${selected}`}>Edit product</Link></div><small>{selectedProduct.sku}{!selectedProduct.active && ' · Inactive product'}</small><details><summary>View source description</summary><p>{selectedProduct.description || 'This product has no description yet.'}</p></details><small>Missing eligible attributes</small><div className="enrichment-tags">{available.map(d => <span key={d.id}>{d.label}</span>)}</div>{!available.length && <p>No missing supported attributes in this product’s attribute set.</p>}</div>}
     {!definitions.isPending && !definitions.error && !eligible.length && <p className="enrichment-warning">No supported attributes are enabled for enrichment. <Link to="/catalog/attributes">Configure a text or choice attribute</Link> with semantic source policy and enrichment enabled.</p>}
     <div className="enrichment-generate-action"><button disabled={!ready || action.busy || products.isFetching || selectedQuery?.isFetching} onClick={() => void generate()}>{action.busy ? 'Generating suggestions…' : 'Generate for selected product'}</button><small>Up to 50 suggestions per run. Review required.</small></div>
    </> : <p className="enrichment-warning">You have read-only access. An authorized catalog editor can generate and review suggestions.</p>}
   </section>
   <aside className="enrichment-guide"><span className="enrichment-eyebrow">How it works</span><h2>Start with a clear description</h2><p>Use one labelled value per line. Labels must match an eligible attribute’s name or code.</p><pre>Style: Casual{'\n'}Occasion: Everyday{'\n'}Finish: Matte</pre><ol><li><strong>Choose a product</strong><span>Check its description and missing attributes.</span></li><li><strong>Generate suggestions</strong><span>Exact source lines stay attached as evidence.</span></li><li><strong>Review and publish</strong><span>Approve useful values or reject a suggestion.</span></li></ol><details><summary>Supported extraction</summary><p>Text and choice attributes are supported. Choice values must match configured options. Separate multiple choices with commas.</p><p>Free-form AI and image inference are not connected. Identical suggestions are reused, including previous rejections.</p></details></aside>
  </div>
  <section className="enrichment-panel enrichment-queue" aria-labelledby="enrichment-queue-title">
   <div className="enrichment-section-heading"><div><span className="enrichment-eyebrow">Step 2 · Review</span><h2 id="enrichment-queue-title">Suggestion review queue</h2></div><button className="secondary" disabled={query.isFetching || action.busy} onClick={() => { setCursors([undefined]); setReview(null); void cache.invalidateQueries({ queryKey: ['catalog-enrichment'] }); }}>Refresh suggestions</button></div>
   <div className="enrichment-queue-toolbar"><label className="field">Review status<select value={status} disabled={action.busy} onChange={event => { setStatus(event.target.value as Status); setCursors([undefined]); setReview(null); }}><option value="pending">Pending</option><option value="approved">Approved</option><option value="rejected">Rejected</option><option value="">All statuses</option></select></label><div><strong>{productFilter ? productDetails.get(productFilter)?.data?.name ?? 'Selected product' : 'All products'}</strong><small>{rows.length} suggestion{rows.length === 1 ? '' : 's'} on this page</small></div>{productFilter && <button className="text-button" disabled={action.busy} onClick={() => { setProductFilter(undefined); setCursors([undefined]); setReview(null); }}>Show all products</button>}</div>
   <Notice error>{query.error?.message}</Notice>
   {query.isPending ? <div className="enrichment-empty" role="status">Loading suggestions…</div> : !rows.length ? !query.error && <div className="enrichment-empty"><span aria-hidden="true">✓</span><h3>{status === 'pending' ? 'No suggestions waiting for review' : 'No matching suggestions'}</h3><p>{status === 'pending' ? 'Choose a product above and generate suggestions to get started.' : 'Try another review status or show all products.'}</p></div> : <div className="table-wrap"><table aria-label="Enrichment suggestions"><thead><tr><th scope="col">Product & attribute</th><th scope="col">Source evidence</th><th scope="col">Review status</th><th scope="col">Actions</th></tr></thead><tbody>{rows.map(s => {
    const definition = definitions.data?.find(d => d.id === s.definition_id), product = productDetails.get(s.product_id);
    return <tr key={s.id}><td data-label="Product & attribute"><Link className="enrichment-product-name" to={`/catalog/products/${s.product_id}`}>{product?.data?.name ?? (product?.isPending ? 'Loading product…' : 'Open product')}</Link><small>{product?.data?.sku ?? s.product_id}</small><div className="enrichment-proposed"><small>{definition?.label ?? s.definition_id}</small><strong>{enrichmentValue(s.value, definition)}</strong></div></td><td data-label="Source evidence"><EnrichmentEvidence suggestion={s}/></td><td data-label="Review status"><span className={`enrichment-status enrichment-status--${s.status}`}>{s.status[0].toUpperCase() + s.status.slice(1)}</span><small>Created {new Date(s.created_at).toLocaleString()}</small>{s.reviewed_at && <small>Reviewed {new Date(s.reviewed_at).toLocaleString()}</small>}{s.reviewed_by && <details><summary>Reviewer</summary><small>{s.reviewed_by}</small></details>}</td><td data-label="Actions">{canWrite && s.status === 'pending' ? <RowActions label={`suggestion ${s.id}`} items={[{ label: 'Approve', disabled: action.busy || !s.evidence, onSelect: () => setReview({ suggestion: s, approve: true }) }, { label: 'Reject', disabled: action.busy, destructive: true, onSelect: () => setReview({ suggestion: s, approve: false }) }]}/> : <span className="enrichment-muted">{s.status === 'pending' ? 'Read only' : 'Reviewed'}</span>}</td></tr>;
   })}</tbody></table></div>}
   <div className="enrichment-pagination"><span>Page {cursors.length}</span><div><button className="secondary" disabled={cursors.length === 1 || query.isFetching || action.busy} onClick={() => { setCursors(cursors.slice(0, -1)); setReview(null); }}>Previous suggestions</button><button className="secondary" disabled={rows.length < PAGE_SIZE || query.isFetching || action.busy} onClick={() => { setCursors([...cursors, rows[rows.length - 1].id]); setReview(null); }}>Next suggestions</button></div></div>
  </section>
  {review && <ReviewDialog suggestion={review.suggestion} approve={review.approve} definition={definitions.data?.find(d => d.id === review.suggestion.definition_id)} productName={productDetails.get(review.suggestion.product_id)?.data?.name ?? 'Selected product'} onClose={() => setReview(null)} onSaved={async message => { await refresh(); setReview(null); action.setError(''); action.setMessage(message); }}/>} 
 </div>;
}
