import { EntityIdLabel } from "./entity-id";
import { EntityMarketEditor, useEditorMarket } from "./markets";
import { EntityTranslationEditor, useEditorLanguage } from "./entity-translation";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { catalogApi, languagesApi, type Category, type CategoryInput } from '@commerce/api-client';
import { Notice, useAction } from '@commerce/ui';
import { PageHeader } from './page-header';
import { RowActions } from './row-actions';
import { CategoryAttributeEditor } from './attributes';
import { categoryDescendants, categoryTrail, categoryTree, filterCategoryTree, type CategoryNode } from './category-tree';
import './category-management.css';

const blank: CategoryInput = {name:'',slug:'',parent_id:null};
function Folder({ open = false }: { open?: boolean }) {
  return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v3M3 7v12a1 1 0 0 0 1 1h15"/>{open ? <path d="M3 11h18l-2 9H3"/> : <path d="M3 8h17v12H3"/>}</svg>;
}
export function CategoryManagement({canWrite,permissions=[]}:{canWrite:boolean;permissions?:string[]}) {
  const {id} = useParams(); const [params] = useSearchParams(); const navigate = useNavigate();
  const cache = useQueryClient(); const action = useAction();
  const query = useQuery({queryKey:['catalog','categories','tree'],queryFn:catalogApi.adminCategories});
  const categories = useMemo(() => query.data ?? [], [query.data]);
  const tree = useMemo(() => categoryTree(query.data ?? []), [query.data]);
  const [search,setSearch] = useState(''); const [expanded,setExpanded] = useState<Set<string>>(new Set());
  const [form,setForm] = useState<CategoryInput>(blank); const [baseline,setBaseline] = useState<CategoryInput>(blank);
  const [focusedId,setFocusedId] = useState<string>();
  const [dragged,setDragged] = useState<string>(); const [dropTarget,setDropTarget] = useState<string>();
  const [move,setMove] = useState<{category:Category;parent:Category|null}>(); const moveDialog = useRef<HTMLDialogElement>(null);
  const [attributeState,setAttributeState]=useState({dirty:false,busy:false});
  const treeRef = useRef<HTMLDivElement>(null); const formDirty = JSON.stringify(form)!==JSON.stringify(baseline); const dirty = formDirty || attributeState.dirty;
  const isNew = id === 'new'; const currentId = isNew ? undefined : id || tree[0]?.category.id;
  const selected = categories.find(category => category.id === currentId);
  const has=(permission:string)=>permissions.includes('*')||permissions.includes(permission);
  const scope=useEditorLanguage({canRead:has('languages.read'),persisted:!!selected,sourceDirty:dirty,sourceBusy:action.busy||attributeState.busy,discardSource:()=>{setForm(baseline);setAttributeState({dirty:false,busy:false});}});
  const marketScope=useEditorMarket(has("markets.read"),scope.dirty||scope.busy||!selected);
  const scoped=!!scope.locale||!!marketScope.market;
  const translations = useQuery({queryKey:['catalog-translations','category',scope.locale], enabled:!!scope.locale&&!marketScope.market, queryFn:async()=>{
    const items=[]; let offset=0;
    while(true){const page=await languagesApi.translations(scope.locale,'category','',offset);items.push(...page.items);offset+=page.items.length;if(offset>=page.total||!page.items.length)break;}
    return Object.fromEntries(items.filter(item=>item.fields.name?.trim()).map(item=>[item.entity_id,item.fields.name]));
  }});
  const names=scope.locale&&!marketScope.market?translations.data:undefined;
  const localizedCategories=useMemo(()=>categories.map(category=>({...category,name:names?.[category.id]||category.name})),[categories,names]);
  const visibleTree = useMemo(() => filterCategoryTree(tree,search,names),[tree,search,names]);
  const visibleIds: string[] = [];
  const collectVisible = (list: CategoryNode[]) => list.forEach(node => { visibleIds.push(node.category.id); if (search.trim() || expanded.has(node.category.id)) collectVisible(node.children); });
  collectVisible(visibleTree);
  const tabStop = focusedId && visibleIds.includes(focusedId) ? focusedId : currentId && visibleIds.includes(currentId) ? currentId : visibleIds[0];
  const excludedParents = useMemo(() => selected ? categoryDescendants(categories,selected.id) : new Set<string>(),[categories,selected]);
  const parentId = params.get('parent');
  const selectionKey = isNew ? `new:${parentId || ''}` : selected?.id;
  const loadedSelection = useRef<string>();
  useEffect(() => {
    if (!query.data || !selectionKey || loadedSelection.current === selectionKey) return;
    const initial = isNew ? {...blank,parent_id:query.data.some(category => category.id === parentId) ? parentId : null} : {name:selected!.name,slug:selected!.slug,parent_id:selected!.parent_id};
    setForm(initial); setBaseline(initial); loadedSelection.current = selectionKey;
    const trail = categoryTrail(query.data, isNew ? parentId || '' : selected!.id);
    setExpanded(previous => new Set([...previous,...trail.map(category=>category.id)]));
  },[selectionKey,query.data,isNew,parentId,selected]);
  useEffect(() => { if (!dirty) return; const warn=(event:BeforeUnloadEvent)=>event.preventDefault(); window.addEventListener('beforeunload',warn); return()=>window.removeEventListener('beforeunload',warn); },[dirty]);
  useEffect(() => { if (!move || !moveDialog.current) return; const dialog=moveDialog.current; dialog.showModal(); return()=>dialog.close(); },[move]);
  const leave = () => !dirty || window.confirm('Discard unsaved category changes?');
  function go(path:string) { if(action.busy || !leave()) return; action.setMessage(''); navigate(path); }
  function toggle(categoryId:string) { setExpanded(previous=>{const next=new Set(previous);if(next.has(categoryId))next.delete(categoryId);else next.add(categoryId);return next;}); }
  function focus(categoryId:string) { treeRef.current?.querySelector<HTMLElement>(`[data-category-id="${CSS.escape(categoryId)}"]`)?.focus(); }
  function keyDown(event:KeyboardEvent, node:CategoryNode, open:boolean) {
    if(event.target!==event.currentTarget)return;
    const entries=Array.from(treeRef.current?.querySelectorAll<HTMLElement>('[role="treeitem"]')??[]);
    const index=entries.indexOf(event.currentTarget as HTMLElement);
    if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();entries[event.key==='Home'?0:event.key==='End'?entries.length-1:Math.max(0,Math.min(entries.length-1,index+(event.key==='ArrowDown'?1:-1)))]?.focus();}
    else if(event.key==='ArrowRight'){event.preventDefault();if(node.children.length){if(!open)toggle(node.category.id);else focus(node.children[0].category.id);}}
    else if(event.key==='ArrowLeft'){event.preventDefault();if(open&&node.children.length&&!search)toggle(node.category.id);else if(node.category.parent_id)focus(node.category.parent_id);}
    else if(event.key==='Enter'||event.key===' '){event.preventDefault();go(`/catalog/categories/${node.category.id}`);}
  }
  function requestMove(parent:Category|null) {
    setDropTarget(undefined);
    const category=categories.find(item=>item.id===dragged);setDragged(undefined);
    if(scoped||!canWrite||!category||category.parent_id===(parent?.id??null)||parent&&categoryDescendants(categories,category.id).has(parent.id)||!leave())return;
    setMove({category,parent});
  }
  function nodes(list:CategoryNode[],level=1) {
    return list.map((node,index)=>{
      const open=!!search.trim()||expanded.has(node.category.id); const active=node.category.id===currentId;
      const validDrop=!scoped&&canWrite&&!!dragged&&!categoryDescendants(categories,dragged).has(node.category.id);
      const displayName=names?.[node.category.id]||node.category.name;
      return <div role="treeitem" key={node.category.id} data-category-id={node.category.id} aria-label={displayName} aria-level={level} aria-setsize={list.length} aria-posinset={index+1} aria-selected={active} aria-expanded={node.children.length?open:undefined} tabIndex={node.category.id===tabStop?0:-1} onFocus={event=>{if(event.target===event.currentTarget)setFocusedId(node.category.id);}} onKeyDown={event=>keyDown(event,node,open)}>
        <div className={`category-tree-row${active?' selected':''}${dropTarget===node.category.id?' drop-target':''}`} style={{paddingLeft:12+(level-1)*18}} draggable={canWrite&&!scoped&&!action.busy} onDragStart={event=>{event.stopPropagation();setDragged(node.category.id);event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',node.category.id);}} onDragEnd={()=>{setDragged(undefined);setDropTarget(undefined);}} onDragOver={event=>{if(validDrop){event.preventDefault();event.stopPropagation();event.dataTransfer.dropEffect='move';setDropTarget(node.category.id);}}} onDragLeave={()=>setDropTarget(undefined)} onDrop={event=>{event.preventDefault();event.stopPropagation();if(validDrop)requestMove(node.category);}} onClick={()=>{focus(node.category.id);go(`/catalog/categories/${node.category.id}`);}}>
          <span className="category-tree-chevron" aria-hidden="true" onClick={event=>{event.stopPropagation();toggle(node.category.id);}}>{node.children.length?(open?'⌄':'›'):''}</span><Folder open={open&&!!node.children.length}/><span className="category-tree-name" dir="auto" lang={names?.[node.category.id]?scope.locale:undefined} title={node.category.name}>{displayName}</span>{node.children.length>0&&<small>{node.children.length}</small>}
        </div>{open&&node.children.length>0&&<div role="group">{nodes(node.children,level+1)}</div>}
      </div>;
    });
  }
  async function refresh(){await cache.invalidateQueries({queryKey:['catalog','categories']});}
  return <main className="catalog-admin category-management"><PageHeader title={<>Categories</>} description={<>Build your catalog hierarchy and manage each category in one workspace.</>} actions={<div className="market-editor-actions">{marketScope.toolbar}<fieldset disabled={!!marketScope.market}>{scope.toolbar}</fieldset></div>}/>
    <Notice error>{query.error?.message||action.error}</Notice><Notice>{action.message}</Notice>
    {scope.locale&&!marketScope.market&&translations.error&&<Notice error>Translated category names could not be loaded. <button type="button" className="text-button" onClick={()=>void translations.refetch()}>Retry</button></Notice>}
    {query.isPending?<p role="status">Loading category tree…</p>:query.error?<button className="secondary" onClick={()=>void query.refetch()}>Retry categories</button>:<div className="category-workspace">
      <aside className="category-tree-panel" aria-label="Category navigation"><div className="category-tree-title"><strong>Category tree</strong><span>{categories.length} categories</span></div>
        {canWrite&&!scoped&&<div className="category-tree-create"><button className="secondary" disabled={action.busy} onClick={()=>go('/catalog/categories/new')}>+ Add root category</button><button disabled={!selected||action.busy} onClick={()=>go(`/catalog/categories/new?parent=${selected!.id}`)}>+ Add subcategory</button></div>}
        <label className="category-tree-search"><span className="sr-only">Search categories</span><input type="search" aria-label="Search categories" placeholder="Search category name or slug…" value={search} onChange={event=>setSearch(event.target.value)}/></label>
        <div className="category-tree-controls"><button className="text-button" onClick={()=>setExpanded(new Set(categories.map(category=>category.id)))}>Expand all</button><span>·</span><button className="text-button" disabled={!!search.trim()} onClick={()=>setExpanded(new Set())}>Collapse all</button></div>
        <div className={`category-tree-root${dropTarget==='root'?' drop-target':''}`} onDragOver={event=>{if(!scoped&&canWrite&&dragged){event.preventDefault();setDropTarget('root');}}} onDragLeave={()=>setDropTarget(undefined)} onDrop={event=>{event.preventDefault();requestMove(null);}}><Folder open/><span>All categories</span></div>
        <div ref={treeRef} role="tree" aria-label="Categories" className="category-tree">{nodes(visibleTree)}</div>
        {!visibleTree.length&&<p className="category-tree-empty">{search?'No matching categories.':'Start by adding a root category.'}</p>}
        <p className="category-tree-help">{canWrite&&!scoped?'Drag a category onto another to change its parent, or use the Parent category field.':'Select a category to view its details.'}</p>
      </aside>
      <section className="category-detail" aria-label="Category details">{isNew&&!canWrite?<p>You do not have permission to create categories.</p>:selected||isNew?marketScope.market&&selected?<EntityMarketEditor key={`${selected.id}-${marketScope.market.id}`} market={marketScope.market} kind="category" id={selected.id} canWrite={canWrite&&has("markets.write")} onStateChange={scope.onEditorStateChange}/>:scope.language&&selected?<EntityTranslationEditor key={`${selected.id}-${scope.locale}`} kind="category" id={selected.id} language={scope.language} canWrite={canWrite&&has('languages.write')} onStateChange={scope.onEditorStateChange} renderEditor={translation=><>
          <div className="category-details-form"><fieldset><legend>Category information</legend>{translation.field('name','Category name')}<label className="field">URL key<input dir="ltr" value={selected.slug} disabled/></label><label className="field">Parent category<select dir="auto" value={selected.parent_id??''} disabled><option value="">Top level (root category)</option>{localizedCategories.map(category=><option key={category.id} value={category.id}>{categoryTrail(localizedCategories,category.id).map(item=>item.name).join(' / ')}</option>)}</select></label></fieldset></div>
          <CategoryAttributeEditor key={selected.id} id={selected.id} translation={translation}/>
          <div className="category-detail-meta"><span>Entity ID</span><code>{selected.entity_id ?? "—"}</code></div>
        </>}/>:<>
        <div className="category-detail-heading"><div><p className="category-path">{selected?categoryTrail(categories,selected.id).map(item=>item.name).join(' / '):form.parent_id?`New subcategory of ${categories.find(item=>item.id===form.parent_id)?.name}`:'New root category'}</p><h2>{isNew?'New category':selected!.name}</h2><EntityIdLabel row={selected}/><span className="category-save-status">{dirty?'Unsaved changes':isNew?'Not saved yet':'Saved category'}</span></div>
          {canWrite&&<div className="category-detail-actions">{selected&&<RowActions label={selected.name} items={[{label:'Delete category',destructive:true,disabled:action.busy||dirty,reason:dirty?'Save or discard changes first':undefined,confirm:'Move products and child categories before deleting this category. This cannot be undone.',onSelect:async()=>{await catalogApi.deleteCategory(selected.id);loadedSelection.current=undefined;await refresh();navigate('/catalog/categories');}}]}/>}<button form="category-details-form" disabled={action.busy||!formDirty}>Save category</button></div>}
        </div>
        <form id="category-details-form" className="category-details-form" onSubmit={event=>{event.preventDefault();if(!canWrite||action.busy)return;void action.run(async()=>{const input={...form,name:form.name.trim(),slug:form.slug.trim()};const saved=await catalogApi.saveCategory(isNew?null:selected!.id,input);setBaseline(input);setForm(input);await refresh();navigate(`/catalog/categories/${saved.id}`,{replace:isNew});action.setMessage('Category saved. The category tree is up to date.');});}}><fieldset disabled={!canWrite||action.busy}><legend>Category information</legend><label className="field">Category name<input required maxLength={120} value={form.name} onChange={event=>setForm({...form,name:event.target.value})}/></label><label className="field">URL key<input required pattern="[a-z0-9-]+" value={form.slug} onChange={event=>setForm({...form,slug:event.target.value})}/><small>Use lowercase letters, numbers and hyphens.</small></label><label className="field">Parent category<select value={form.parent_id??''} onChange={event=>setForm({...form,parent_id:event.target.value||null})}><option value="">Top level (root category)</option>{categories.filter(category=>!excludedParents.has(category.id)).map(category=><option key={category.id} value={category.id}>{categoryTrail(categories,category.id).map(item=>item.name).join(' / ')}</option>)}</select><small>Choose another parent to move this category and its subcategories.</small></label></fieldset>
          {canWrite&&formDirty&&<button type="button" className="text-button" disabled={action.busy} onClick={()=>{if(leave())setForm(baseline);}}>Discard changes</button>}
        </form>
        {selected&&canWrite&&<CategoryAttributeEditor key={selected.id} id={selected.id} onStateChange={setAttributeState}/>}
        {selected&&<div className="category-detail-meta"><span>Entity ID</span><code>{selected.entity_id ?? "—"}</code></div>}
      </>:<div className="category-detail-empty"><Folder open/><h2>{id?'Category unavailable':'Your catalog starts here'}</h2><p>{id?'Select another category from the tree.':'Add a root category, then organize your catalog with subcategories.'}</p></div>}</section>
    </div>}
    {move&&<dialog ref={moveDialog} className="category-move-dialog" onCancel={event=>{if(action.busy)event.preventDefault();else setMove(undefined);}} aria-labelledby="category-move-heading"><h2 id="category-move-heading">Move {move.category.name}?</h2><p>{move.parent?`New parent: ${move.parent.name}`:'Move to the top level as a root category.'} All subcategories will move with it.</p><Notice error>{action.error}</Notice><div><button className="secondary" autoFocus disabled={action.busy} onClick={()=>setMove(undefined)}>Cancel</button><button disabled={action.busy} onClick={()=>void action.run(async()=>{await catalogApi.saveCategory(move.category.id,{name:move.category.name,slug:move.category.slug,parent_id:move.parent?.id??null});loadedSelection.current=undefined;setMove(undefined);await refresh();navigate(`/catalog/categories/${move.category.id}`);action.setMessage('Category moved.');})}>Confirm move</button></div></dialog>}
  </main>;
}
