import { EntityMarketEditor, useEditorMarket } from "./markets";
import { EntityTranslationEditor, useEditorLanguage, type TranslationEditorFields, type TranslationReleaseState } from "./entity-translation";
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { catalogApi, contentApi, categoryNavigation, type ContentBlock } from '@commerce/api-client';
import { Field, Notice } from '@commerce/ui';
import { PageHeader } from './page-header';
import { ContentEditor } from './content';
import './megamenu.css';

export const newMenuItem = (): ContentBlock => ({kind:'link',heading:'',text:'',image_id:null,link_label:'New menu',link_url:'/search',navigation:{icon:'',badge:'',enabled:true,new_tab:false,columns:3,links:[]}});
export function MegamenuAdmin({canWrite,canPublish,permissions=[]}:{canWrite:boolean;canPublish:boolean;permissions?:string[]}) {
  const [releaseBusy, setReleaseBusy] = useState(false);
  const documents=useQuery({queryKey:['cms'],queryFn:contentApi.list});
  const document=documents.data?.find(d=>d.kind==='navigation' && d.key==='navigation');
  const categories=useQuery({queryKey:['catalog','categories','tree'],queryFn:catalogApi.adminCategories});
  const live=useQuery({queryKey:['cms','live-navigation'],queryFn:()=>contentApi.public('navigation'),refetchInterval:10000});
  const detail=useQuery({queryKey:['cms',document?.id],queryFn:()=>contentApi.detail(document!.id),enabled:!!document});
  const has=(permission:string)=>permissions.includes("*")||permissions.includes(permission);
  const scope=useEditorLanguage({canRead:has("languages.read"),persisted:!!document, sourceBusy:releaseBusy});
  const marketScope=useEditorMarket(has("markets.read"),scope.dirty||scope.busy||!document);
  return <main className="catalog-admin megamenu-admin"><PageHeader title="Navigation" actions={<div className="market-editor-actions">{marketScope.toolbar}<fieldset disabled={!!marketScope.market}>{scope.toolbar}</fieldset></div>}/>
    <section className="menu-connection" aria-label="Menu publication status"><strong>{live.isPending ? 'Checking storefront menu…' : live.error ? 'Storefront status unavailable' : live.data ? `Published menu · Version ${live.data.version}` : 'Catalog category bar is active'}</strong><p>{live.error ? 'The published menu could not be checked. Retry before planning a release.' : live.data ? 'The storefront uses the published revision. Saving a draft does not change the live menu.' : 'The storefront displays Shop all and top-level catalog categories until a menu is published. Start with those same links, then customize and publish.'}</p>{live.error && <button type="button" onClick={()=>void live.refetch()}>Retry storefront status</button>}</section>
    <Notice error>{documents.error?.message || detail.error?.message || (!document ? categories.error?.message : '')}</Notice>
    {documents.isPending || (!document && categories.isPending) || (document && detail.isPending) ? <p>Loading navigation…</p> : !documents.error && !detail.error && (marketScope.market && document ? <EntityMarketEditor key={`${document.id}-${marketScope.market.id}`} market={marketScope.market} kind="navigation" id={document.id} canWrite={canWrite&&has("markets.write")} onStateChange={scope.onEditorStateChange}/> : scope.language && document ? <EntityTranslationEditor key={`${document.id}-${scope.locale}`} kind="navigation" id={document.id} language={scope.language} externalBusy={releaseBusy} canWrite={canWrite&&has("languages.write")} onStateChange={scope.onEditorStateChange} renderEditor={editor=><MenuTranslationEditor editor={editor} blocks={detail.data?.revisions.find(revision=>String(revision.version)===editor.source.__version)?.blocks??[]} language={scope.language!.name}/>} renderRelease={state=><MenuTranslationRelease id={document.id} state={state} canPublish={canPublish} onBusyChange={setReleaseBusy}/>} preview={fields=>fields.__version===String(detail.data?.document.version)?<MenuPreview blocks={translatedMenuBlocks(detail.data?.revisions[0]?.blocks??[],fields)}/>:<p>The source menu changed. Reload this page to preview its latest structure.</p>}/> : <ContentEditor key={document ? `${document.id}:${document.version}` : 'new-navigation'} detail={detail.data} initialNavigation={categoryNavigation(categories.data ?? [])} navigation canWrite={canWrite} canPublish={canPublish} saved={()=>{}} onStateChange={scope.onEditorStateChange}/>)}
  </main>;
}
export function translatedMenuBlocks(blocks: ContentBlock[], fields: Record<string,string>): ContentBlock[] {
  return blocks.map((block,i)=>({...block,link_label:fields[`item.${i}.label`]??block.link_label,navigation:block.navigation?{...block.navigation,badge:fields[`item.${i}.badge`]??block.navigation.badge,links:block.navigation.links.map((link,j)=>({...link,label:fields[`item.${i}.link.${j}.label`]??link.label,group:fields[`item.${i}.link.${j}.group`]??link.group,description:fields[`item.${i}.link.${j}.description`]??link.description}))}:block.navigation}));
}
function Destination({value,onChange}:{value:string;onChange:(value:string)=>void}) {
  const categories=useQuery({queryKey:['catalog','categories','tree'],queryFn:catalogApi.adminCategories});
  const pages=useQuery({queryKey:['cms'],queryFn:contentApi.list});
  const [mode,setMode]=useState(value.startsWith('/categories/')?'category':value.startsWith('/pages/')?'page':'custom');
  useEffect(()=>{if(value)setMode(value.startsWith('/categories/')?'category':value.startsWith('/pages/')?'page':'custom');},[value]);
  const destinations=mode==='category' ? categories.data?.map(c=>({value:`/categories/${c.slug}`,label:c.name})) : pages.data?.filter(p=>p.kind==='page').map(p=>({value:`/pages/${p.key}`,label:p.key}));
  return <div className="form-grid"><label className="field">Link type<select value={mode} onChange={e=>{setMode(e.target.value);onChange('');}}><option value="category">Category</option><option value="page">Custom page</option><option value="custom">Custom URL</option></select></label>
    {mode==='custom' ? <Field label="Destination" required value={value} maxLength={2000} placeholder="/search or https://example.com" onChange={e=>onChange(e.target.value)}/> : <label className="field">{mode==='category'?'Category':'Page'}<select required value={value} onChange={e=>onChange(e.target.value)}><option value="">Choose destination</option>{value && !destinations?.some(destination=>destination.value===value) && <option value={value}>{value} · Check destination</option>}{destinations?.map(destination=><option key={destination.value} value={destination.value}>{destination.label}</option>)}</select></label>}
    <Notice error>{categories.error?.message || pages.error?.message}</Notice>
  </div>;
}
export function MenuItemsEditor({blocks,onChange}:{blocks:ContentBlock[];onChange:(blocks:ContentBlock[])=>void}) {
  const [selected,setSelected]=useState(0);
  const [removing,setRemoving]=useState<number|null>(null);
  const active=Math.min(selected,Math.max(0,blocks.length-1));
  const add=()=>{setSelected(blocks.length);setRemoving(null);onChange([...blocks,newMenuItem()]);};
  const update=(index:number,b:ContentBlock)=>onChange(blocks.map((old,i)=>i===index?b:old));
  const move=(index:number,delta:number)=>{const next=[...blocks];[next[index],next[index+delta]]=[next[index+delta],next[index]];setSelected(index+delta);setRemoving(null);onChange(next);};
  return <div className="menu-editor"><datalist id="menu-icon-options">{["🛍","🍎","🥬","🥐","☕","💎","👗","🏠","🎁","⭐","🔥","✨","📦","☎"].map(icon=><option key={icon} value={icon}/>)}</datalist><div className="menu-workspace-heading"><div><h3>Navigation builder</h3><p>Arrange your menu, then select an item to edit its details.</p></div><span className="menu-count">{blocks.length} / 30 items · {blocks.filter(b=>b.navigation?.enabled??true).length} visible</span></div><div className="menu-workspace"><aside className="menu-outline" aria-label="Menu structure"><div className="menu-outline-heading"><strong>Menu items</strong><span>Storefront order</span></div>{blocks.map((b,i)=><button type="button" className={`menu-outline-item ${active===i?'is-selected':''}`} key={i} aria-pressed={active===i} onClick={()=>{setSelected(i);setRemoving(null);}}><span className="menu-outline-number">{i+1}</span><span className="menu-outline-copy"><strong>{b.navigation?.icon} {b.link_label||'Untitled item'}</strong><small>{b.navigation?.links.length ? `${b.navigation.links.length} dropdown links` : 'Direct link'}{b.navigation?.enabled===false?' · Hidden':''}</small></span><span aria-hidden="true">›</span></button>)}<button type="button" className="secondary menu-add-item" disabled={blocks.length>=30} onClick={add}>+ Add menu item</button>{!blocks.length&&<p className="menu-outline-empty">Start with a menu item or import your catalog categories.</p>}</aside><div className="menu-item-detail">{blocks.map((b,i)=>{
    if(i!==active)return null;
    const n=b.navigation ?? newMenuItem().navigation!;
    const nav=(patch:Partial<typeof n>)=>update(i,{...b,navigation:{...n,...patch}});
    return <fieldset key={i}><legend>{i+1}. {b.link_label || 'Menu item'}{!n.enabled?' · Hidden':''}</legend><div className="menu-toolbar"><button type="button" className="secondary" disabled={i===0} onClick={()=>move(i,-1)}>Move up</button><button type="button" className="secondary" disabled={i===blocks.length-1} onClick={()=>move(i,1)}>Move down</button><button type="button" className="secondary" disabled={blocks.length>=30} onClick={()=>{setSelected(blocks.length);onChange([...blocks,structuredClone(b)]);}}>Duplicate</button><button type="button" className="text-button danger" onClick={()=>setRemoving(i)}>Remove item</button></div>{removing===i&&<div className="menu-delete-confirm" role="alert"><div><strong>Remove {b.link_label||'this item'}?</strong><p>This also removes its {n.links.length} dropdown links from the draft.</p></div><button type="button" onClick={()=>{onChange(blocks.filter((_,j)=>j!==i));setSelected(Math.max(0,i-1));setRemoving(null);}}>Confirm removal</button><button type="button" className="secondary" onClick={()=>setRemoving(null)}>Cancel</button></div>}<div className="menu-item-intro"><span className="menu-count">{n.links.length?'Dropdown menu':'Direct link'}</span><p>Set the label and destination customers see in your storefront navigation.</p></div>
      <div className="form-grid"><Field label="Label" required maxLength={100} value={b.link_label} onChange={e=>update(i,{...b,link_label:e.target.value})}/><Field label="Icon" list="menu-icon-options" maxLength={8} placeholder="◇ 🛍 🍎" value={n.icon} onChange={e=>nav({icon:e.target.value})}/><Field label="Badge" maxLength={40} placeholder="New / Sale" value={n.badge} onChange={e=>nav({badge:e.target.value})}/><label className="field">Dropdown columns<select value={n.columns} onChange={e=>nav({columns:Number(e.target.value)})}>{[1,2,3,4].map(c=><option key={c}>{c}</option>)}</select></label></div>
      <Destination value={b.link_url} onChange={link_url=>update(i,{...b,link_url})}/>
      <div className="menu-toolbar"><label><input type="checkbox" checked={n.enabled} onChange={e=>nav({enabled:e.target.checked})}/> Visible</label><label><input type="checkbox" checked={n.new_tab} onChange={e=>nav({new_tab:e.target.checked})}/> Open in new tab</label></div>
      <div className="menu-dropdown-heading"><h3>Dropdown links</h3><p>{n.links.length} / 40 links · Use the same column heading to group related destinations.</p></div>{n.links.map((link,j)=><fieldset key={j}><legend>Dropdown link {j+1}</legend><div className="form-grid">{(['label','group','icon','description'] as const).map(key=><Field key={key} label={{label:'Link label',group:'Column heading',icon:'Icon',description:'Description'}[key]} list={key==='icon'?'menu-icon-options':undefined} required={key==='label'} maxLength={key==='icon'?8:key==='description'?200:100} value={link[key]} onChange={e=>nav({links:n.links.map((old,k)=>k===j?{...old,[key]:e.target.value}:old)})}/>)}</div><Destination value={link.url} onChange={url=>nav({links:n.links.map((old,k)=>k===j?{...old,url}:old)})}/><label><input type="checkbox" checked={link.new_tab} onChange={e=>nav({links:n.links.map((old,k)=>k===j?{...old,new_tab:e.target.checked}:old)})}/> Open in new tab</label><div className="menu-toolbar"><button type="button" className="secondary" disabled={j===0} onClick={()=>{const links=[...n.links];[links[j-1],links[j]]=[links[j],links[j-1]];nav({links});}}>Move up</button><button type="button" className="secondary" disabled={j===n.links.length-1} onClick={()=>{const links=[...n.links];[links[j+1],links[j]]=[links[j],links[j+1]];nav({links});}}>Move down</button><button type="button" className="text-button danger" onClick={()=>nav({links:n.links.filter((_,k)=>k!==j)})}>Remove link</button></div></fieldset>)}
      <button type="button" className="secondary" disabled={n.links.length>=40} onClick={()=>nav({links:[...n.links,{label:'',url:'/search',group:'',icon:'',description:'',new_tab:false}]})}>Add dropdown link</button>
    </fieldset>;
  })}{!blocks.length&&<div className="menu-builder-empty"><h3>Build your storefront navigation</h3><p>Add a direct link or a dropdown with grouped categories and pages.</p><button type="button" onClick={add}>Add first menu item</button></div>}</div></div></div>;
}
export function MenuPreview({blocks}:{blocks:ContentBlock[]}) {
  const [selected,setSelected]=useState(0);
  const visible=blocks.filter(b=>b.navigation?.enabled??true);
  const active=Math.min(selected,Math.max(0,visible.length-1));
  const item=visible[active];
  return <div className="menu-preview"><div className="menu-preview-heading"><div><strong>Storefront preview</strong><p>Select a menu item to inspect its dropdown.</p></div><span className="menu-count">Draft preview</span></div><nav className="menu-preview-bar" aria-label="Storefront bar preview">{visible.map((b,i)=><button type="button" className={active===i?'is-selected':''} aria-pressed={active===i} key={i} onClick={()=>setSelected(i)}>{b.navigation?.icon} {b.link_label||'Untitled item'}{b.navigation?.links.length ? " ⌄" : ""}{b.navigation?.badge && <small>{b.navigation.badge}</small>}</button>)}</nav>{item?<section><div className="menu-preview-destination"><strong>{item.link_label}</strong><span>{item.link_url}{item.navigation?.new_tab?' · Opens in new tab':''}</span></div>{item.navigation?.links.length ? <div className="menu-preview-columns" style={{gridTemplateColumns:`repeat(${item.navigation.columns || 1},minmax(0,1fr))`}}>{Array.from(new Set(item.navigation.links.map(l=>l.group))).map(group=><div key={group}><h4>{group||'Explore'}</h4>{item.navigation?.links.filter(l=>l.group===group).map((l,j)=><div className="menu-preview-link" key={j}><span>{l.icon} {l.label||'Untitled link'}</span>{l.description&&<small>{l.description}</small>}<small className="menu-preview-url">{l.url}</small></div>)}</div>)}</div>:<p className="menu-preview-empty">This item takes customers directly to its destination.</p>}</section>:<p className="menu-preview-empty">No visible menu items. Enable an item to preview your navigation.</p>}</div>;
}

function MenuTranslationEditor({editor, blocks, language}: {editor: TranslationEditorFields; blocks: ContentBlock[]; language: string}) {
  const [selected, setSelected] = useState(0);
  const active = Math.min(selected, Math.max(0, blocks.length - 1));
  const labels = translatedMenuBlocks(blocks, editor.values);
  const item = blocks[active];
  return <div className="menu-translation-builder">
    {editor.field('title', 'Menu title')}
    <div className="menu-workspace-heading"><div><h3>Navigation builder</h3><p>Select a menu item to translate its label and dropdown content.</p></div><span className="menu-count">{blocks.length} items · {language}</span></div>
    <div className="menu-workspace">
      <aside className="menu-outline" aria-label="Menu structure"><div className="menu-outline-heading"><strong>Menu items</strong><span>Storefront order</span></div>
        {labels.map((block, index) => <button type="button" key={index} className={`menu-outline-item ${active === index ? 'is-selected' : ''}`} aria-pressed={active === index} onClick={() => setSelected(index)}>
          <span className="menu-outline-number">{index + 1}</span><span className="menu-outline-copy"><strong dir="auto">{block.navigation?.icon} {block.link_label || 'Untitled item'}</strong><small>{block.navigation?.links.length ? `${block.navigation.links.length} dropdown links` : 'Direct link'}{block.navigation?.enabled === false ? ' · Hidden' : ''}</small></span><span aria-hidden="true">›</span>
        </button>)}
      </aside>
      <div className="menu-item-detail menu-translation-detail">{item ? <section aria-label={`Menu item ${active + 1} translations`}>
        <h3><span dir="auto">{labels[active].link_label}</span></h3>
        <div className="menu-item-intro"><span className="menu-count">{item.navigation?.links.length ? 'Dropdown menu' : 'Direct link'}</span><p>Translate the text customers see. Use source value when a field should stay the same.</p></div>
        <div className="form-grid">{editor.field(`item.${active}.label`, 'Label')}{editor.field(`item.${active}.badge`, 'Badge')}</div>
        <div className="menu-shared-destination"><span>Destination · Shared across languages</span><code dir="ltr">{item.link_url}</code></div>
        {!!item.navigation?.links.length && <div className="menu-dropdown-heading"><h3>Dropdown links</h3><p>{item.navigation.links.length} links · Translate labels, column headings and descriptions.</p></div>}
        {item.navigation?.links.map((link, index) => <section key={index} className="menu-translation-link" aria-label={`Dropdown link ${index + 1} translations`}>
          <h4>Dropdown link {index + 1}</h4><div className="form-grid">{editor.field(`item.${active}.link.${index}.label`, 'Link label')}{editor.field(`item.${active}.link.${index}.group`, 'Column heading')}{editor.field(`item.${active}.link.${index}.description`, 'Description')}</div>
          <div className="menu-shared-destination"><span>Destination · Shared across languages</span><code dir="ltr">{link.url}</code></div>
        </section>)}
      </section> : <Notice>The menu structure changed. Reload the page to load the matching source revision before translating.</Notice>}</div>
    </div>
  </div>;
}

function MenuTranslationRelease({id, state, canPublish, onBusyChange}: {id: string; state: TranslationReleaseState; canPublish: boolean; onBusyChange: (busy: boolean) => void}) {
  const cache = useQueryClient();
  const [start, setStart] = useState(''), [end, setEnd] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  if (!canPublish) return null;
  const ready = state.reviewed && !state.dirty && !state.busy;
  return <section className="menu-translation-release form-card" aria-label="Menu translation publication">
    <h3>Publish or schedule menu</h3><p>Release the source menu and its saved, reviewed translations together.</p>
    <form onSubmit={async event => {
      event.preventDefault(); if (!ready || busy) return;
      setBusy(true); onBusyChange(true); setError(''); setMessage('');
      try {
        const latest = await contentApi.detail(id);
        const revision = latest.revisions.find(item => String(item.version) === state.source.__version);
        if (!revision || String(latest.document.version) !== state.source.__version) throw new Error('The source menu changed. Reload and review the current translation before publishing.');
        await contentApi.publish(id, {revision_id: revision.id, starts_at: start ? new Date(start).toISOString() : null, ends_at: end ? new Date(end).toISOString() : null});
        await cache.invalidateQueries({queryKey: ['cms']});
        setMessage(start ? 'Menu release scheduled. The current storefront menu stays live until then.' : 'Menu published with its reviewed translations.');
      } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to publish menu'); }
      finally { setBusy(false); onBusyChange(false); }
    }}>
      <fieldset disabled={!ready || busy}><div className="form-grid"><Field label="Start (local time; blank = now)" type="datetime-local" value={start} onChange={event => setStart(event.target.value)}/><Field label="Unpublish at (local time; optional)" type="datetime-local" value={end} min={start || undefined} onChange={event => setEnd(event.target.value)}/></div></fieldset>
      {!ready && <p className="help">Save and review this translation before publishing.</p>}
      <Notice error>{error}</Notice><Notice>{message}</Notice>
      <button disabled={!ready || busy}>{busy ? 'Applying release…' : start ? 'Schedule menu' : 'Publish menu'}</button>
    </form>
  </section>;
}
