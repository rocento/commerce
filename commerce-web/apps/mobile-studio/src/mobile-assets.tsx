import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { mobileApi, type MobileAsset, type MobileConfig, type MobileAssetFolder, type MobileEnvironment } from '@commerce/api-client';
import './mobile-assets.css';

function Dialog({ title, busy = false, close, children }: { title: string; busy?: boolean; close: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null), id = useId();
  useEffect(() => { const dialog = ref.current!; dialog.showModal(); return () => dialog.close(); }, []);
  return <dialog ref={ref} className="ms-media-dialog" aria-labelledby={id} onCancel={e => { e.preventDefault(); if (!busy) close(); }}>
    <header><h2 id={id}>{title}</h2><button type="button" disabled={busy} onClick={close}>Close</button></header>{children}
  </dialog>;
}

export function MobileAssets({ assets, config, merchant, environment, disabled, upload, selectLogo, assetChanged }: {
  assets: MobileAsset[]; config: MobileConfig; merchant: string; environment: MobileEnvironment; disabled: boolean;
  upload: (name: string, file: File, folderId: string | null) => Promise<boolean>; selectLogo: (asset: MobileAsset) => void; assetChanged: (asset: MobileAsset) => void;
}) {
  const [search, setSearch] = useState(''), [folder, setFolder] = useState('all'), [sort, setSort] = useState('recent');
  const [detail, setDetail] = useState<MobileAsset>(), [uploadOpen, setUploadOpen] = useState(false);
  const [queue, setQueue] = useState<{ file: File; name: string }[]>([]), [uploading, setUploading] = useState(false);
  const [error, setError] = useState(''), [progress, setProgress] = useState('');
  const uploadLock = useRef(false);
  const [folders, setFolders] = useState<MobileAssetFolder[]>([]), [items, setItems] = useState<MobileAsset[]>([]);
  const [total, setTotal] = useState(0), [offset, setOffset] = useState(0), [term, setTerm] = useState('');
  const [loading, setLoading] = useState(true), [loadError, setLoadError] = useState(''), [working, setWorking] = useState(false), [revision, refresh] = useState(0);
  const [selected, setSelected] = useState<string[]>([]), [expanded, setExpanded] = useState<string[]>([]);
  const [folderForm, setFolderForm] = useState<{ id: string | null; name: string; parentId: string | null }>();
  const [move, setMove] = useState<{ ids: string[]; destination: string }>(), [deleting, setDeleting] = useState<MobileAssetFolder>();
  const [assetName, setAssetName] = useState('');
  const dragged = useRef<string[]>([]), actionLock = useRef(false);
  const blocked = disabled || working || uploading;
  const current = folders.find(f => f.id === folder), destination = current?.id || null;
  useEffect(() => { const timer = setTimeout(() => { setTerm(search); setOffset(0); setSelected([]); }, 250); return () => clearTimeout(timer); }, [search]);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setLoadError('');
    Promise.all([mobileApi.assetFolders(merchant, environment, controller.signal), mobileApi.assetLibrary(merchant, environment, { folder, q: term, offset, sort }, controller.signal)])
      .then(([nextFolders, page]) => {
        if (controller.signal.aborted) return;
        setFolders(nextFolders); setItems(page.items); setTotal(page.total);
        if (offset > 0 && offset >= page.total) setOffset(Math.max(0, Math.ceil(page.total / 48) - 1) * 48);
      }).catch(e => { if (!controller.signal.aborted) setLoadError(e instanceof Error ? e.message : 'Could not load images.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [merchant, environment, folder, term, offset, sort, revision, assets]);
  function trail(id: string | null) {
    const result: MobileAssetFolder[] = [], seen = new Set<string>();
    while (id && !seen.has(id)) { seen.add(id); const item = folders.find(f => f.id === id); if (!item) break; result.unshift(item); id = item.parentId; }
    return result;
  }
  function navigate(id: string) { setFolder(id); setOffset(0); setSelected([]); setSearch(''); setTerm(''); setExpanded(previous => [...new Set([...previous, ...trail(id).map(f => f.id)])]); }
  async function action(work: () => Promise<void>) {
    if (blocked || actionLock.current) return;
    actionLock.current = true; setWorking(true); setError('');
    try { await work(); refresh(value => value + 1); setSelected([]); }
    catch (e) { setError(e instanceof Error ? e.message : 'Unable to save changes. Please retry.'); }
    finally { actionLock.current = false; setWorking(false); }
  }
  function openMove(ids: string[], target = destination || '') { setError(''); setMove({ ids, destination: target }); }
  function drop(event: React.DragEvent, target: string) { event.preventDefault(); if (!blocked && dragged.current.length) openMove(dragged.current, target); dragged.current = []; }
  function tree(parent: string | null, seen = new Set<string>()): ReactNode {
    return folders.filter(f => f.parentId === parent && !seen.has(f.id)).map(f => <li key={f.id}>
      <div className="ms-media-folder-row" onDragOver={e => { if (!blocked && dragged.current.length) e.preventDefault(); }} onDrop={e => drop(e, f.id)}>
        {folders.some(child => child.parentId === f.id) && <button aria-label={`${expanded.includes(f.id) ? 'Collapse' : 'Expand'} ${f.name}`} aria-expanded={expanded.includes(f.id)} onClick={() => setExpanded(previous => previous.includes(f.id) ? previous.filter(id => id !== f.id) : [...previous, f.id])}>{expanded.includes(f.id) ? '⌄' : '›'}</button>}
        <button aria-current={folder === f.id ? 'true' : undefined} onClick={() => navigate(f.id)}><span>▱ {f.name}</span><small>{f.assetCount}</small></button>
      </div>{expanded.includes(f.id) && <ul>{tree(f.id, new Set([...seen, f.id]))}</ul>}
    </li>);
  }
  const folderOptions = (exclude?: string) => <><option value="">Unfiled / root</option>{folders.filter(f => !exclude || !trail(f.id).some(part => part.id === exclude)).map(f => <option key={f.id} value={f.id}>{trail(f.id).map(part => part.name).join(' / ')}</option>)}</>;
  const bannerIds = new Set(config.screens.home.sections.flatMap(section => 'imageAssetId' in section.props ? [section.props.imageAssetId, ...(section.props.additionalImageAssetIds || [])] : []));
  function usage(a: MobileAsset) { return [a.id === config.brand.logoAssetId && 'App logo', bannerIds.has(a.id) && 'Banner'].filter(Boolean).join(' · ') || 'Not used in this draft'; }
  function selectFiles(files: File[]) {
    if (files.length > 50 || files.some(file => !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024 || !file.size)) {
      setQueue([]); setError('Choose up to 50 PNG, JPEG or WebP images, each between 1 byte and 5 MiB.'); return;
    }
    setError(''); setProgress(''); setQueue(files.map(file => ({ file, name: file.name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ').slice(0, 200) })));
  }
  async function submit() {
    if (blocked || uploadLock.current || !queue.length) return;
    uploadLock.current = true; setUploading(true); setError('');
    let completed = 0;
    try {
      for (const item of queue) {
        if (!await upload(item.name.trim(), item.file, destination)) { setError('Upload failed. Remaining images are ready to retry.'); return; }
        completed++; setQueue(previous => previous.filter(pending => pending !== item)); setProgress(`${completed} of ${queue.length} uploaded`);
      }
      setUploadOpen(false);
    } catch (e) { setError(e instanceof Error ? e.message : 'Upload failed. Please retry.'); }
    finally { uploadLock.current = false; setUploading(false); }
  }
  return <section className="ms-media-library" aria-label="Asset library">
    <div className="ms-media-heading"><div><h3>Media library</h3><p>Organize images for your app’s logo and banners.</p></div><div className="ms-media-actions"><button disabled={blocked || loading || !!loadError} onClick={() => { setError(''); setFolderForm({ id: null, name: '', parentId: destination }); }}>New folder</button><button disabled={blocked || loading || !!loadError} onClick={() => { setQueue([]); setError(''); setProgress(''); setUploadOpen(true); }}>Upload images</button></div></div>
    {error && !folderForm && !move && !deleting && !detail && !uploadOpen && <p role="alert" className="ms-error">{error}</p>}
    <div className="ms-media-browser">
      <nav className="ms-media-collections" aria-label="Asset folders">
        <strong>Folders</strong>
        <button aria-current={folder === 'all' ? 'true' : undefined} onClick={() => navigate('all')}>All images</button>
        <button aria-current={folder === 'unfiled' ? 'true' : undefined} onClick={() => navigate('unfiled')} onDragOver={e => { if (!blocked && dragged.current.length) e.preventDefault(); }} onDrop={e => drop(e, '')}>Unfiled</button>
        <ul>{tree(null)}</ul><p>Move selected images with the toolbar or drag them onto a folder. Images are private to this merchant.</p>
      </nav>
      <div className="ms-media-content">
        <nav className="ms-media-breadcrumbs" aria-label="Media path"><button onClick={() => navigate('all')}>All images</button>{trail(destination).map(f => <span key={f.id}> / <button onClick={() => navigate(f.id)}>{f.name}</button></span>)}{folder === 'unfiled' && <span> / Unfiled</span>}</nav>
        <div className="ms-media-heading"><h3>{current?.name || (folder === 'unfiled' ? 'Unfiled' : 'All images')}</h3>{current && <div className="ms-media-actions"><button disabled={blocked} onClick={() => { setError(''); setFolderForm({ id: current.id, name: current.name, parentId: current.parentId }); }}>Rename or move folder</button><button disabled={blocked} onClick={() => { setError(''); setDeleting(current); }}>Delete folder</button></div>}</div>
        <div className="ms-media-toolbar"><label>Search images<input type="search" maxLength={200} placeholder="Search by name…" value={search} onChange={e => setSearch(e.target.value)} /></label><label>Sort by<select value={sort} onChange={e => { setSort(e.target.value); setOffset(0); setSelected([]); }}><option value="recent">Newest first</option><option value="name">Name A–Z</option></select></label><button disabled={loading} onClick={() => refresh(v => v + 1)}>Refresh</button></div>
        {!term && folder !== 'unfiled' && <div className="ms-media-child-folders">{folders.filter(f => f.parentId === destination).map(f => <button key={f.id} onClick={() => navigate(f.id)}>▱ {f.name} <small>{f.assetCount} images</small></button>)}</div>}
        {loadError ? <p role="alert" className="ms-error">{loadError} <button onClick={() => refresh(v => v + 1)}>Retry library</button></p> : loading ? <p role="status">Loading images…</p> : <>
        <p className="ms-media-count" role="status">{total} {total === 1 ? 'image' : 'images'}</p>
        <div className="ms-media-selection"><label><input type="checkbox" aria-label="Select page" checked={items.length > 0 && items.every(a => selected.includes(a.id))} disabled={blocked || !items.length} onChange={e => setSelected(e.target.checked ? items.map(a => a.id) : [])} />Select page</label><span>{selected.length} selected</span><button disabled={blocked || !selected.length} onClick={() => openMove(selected)}>Move selected</button>{selected.length > 0 && <button onClick={() => setSelected([])}>Clear selection</button>}</div>
        <div className="ms-media-grid">{items.map(asset => <article key={asset.id} className={selected.includes(asset.id) ? 'selected' : ''} draggable={!blocked} onDragStart={e => { dragged.current = selected.includes(asset.id) ? selected : [asset.id]; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', JSON.stringify(dragged.current)); }} onDragEnd={() => { dragged.current = []; }}>
          <label className="ms-media-select"><input type="checkbox" aria-label={`Select ${asset.name}`} disabled={blocked} checked={selected.includes(asset.id)} onChange={e => setSelected(previous => e.target.checked ? [...previous, asset.id] : previous.filter(id => id !== asset.id))} /></label>
          <button className="ms-media-thumbnail" aria-label={`View ${asset.name}`} onClick={() => { setError(''); setDetail(asset); setAssetName(asset.name); }}><img loading="lazy" src={mobileApi.assetUrl(merchant, asset)} alt={asset.name} /></button>
          <div className="ms-media-caption"><strong>{asset.name}</strong><small>{asset.width && asset.height ? `${asset.width} × ${asset.height}` : 'Verified image'}</small><span>{usage(asset)}</span></div>
          <button className="ms-media-use" disabled={blocked || asset.kind !== 'image' || asset.id === config.brand.logoAssetId} onClick={() => selectLogo(asset)}>{asset.id === config.brand.logoAssetId ? 'Current logo' : 'Use as logo'}</button>
        </article>)}</div>
        {!items.length && <div className="ms-media-empty"><h3>{term ? 'No matching images' : 'No images in this folder'}</h3><p>{term ? 'Try another search or folder.' : 'Upload images here or move images from another folder.'}</p>{term && <button onClick={() => { setSearch(''); setTerm(''); }}>Clear search</button>}</div>}
        <div className="ms-media-pagination"><span>{total ? `${offset + 1}–${Math.min(offset + 48, total)} of ${total}` : '0 images'}</span><button disabled={offset === 0 || working} onClick={() => { setOffset(Math.max(0, offset - 48)); setSelected([]); }}>Previous</button><button disabled={offset + 48 >= total || working} onClick={() => { setOffset(offset + 48); setSelected([]); }}>Next</button></div>
        </>}
      </div>
    </div>
    {folderForm && <Dialog title={folderForm.id ? 'Rename or move folder' : 'Create folder'} busy={working} close={() => setFolderForm(undefined)}><form onSubmit={e => { e.preventDefault(); void action(async () => { const saved = await mobileApi.saveAssetFolder(merchant, environment, folderForm.id, folderForm.name.trim(), folderForm.parentId); navigate(saved.id); setFolderForm(undefined); }); }}><fieldset disabled={blocked}><label>Folder name<input autoFocus required maxLength={100} pattern={'[^/\\]+'} value={folderForm.name} onChange={e => setFolderForm({ ...folderForm, name: e.target.value })} /></label><label>Parent folder<select value={folderForm.parentId || ''} onChange={e => setFolderForm({ ...folderForm, parentId: e.target.value || null })}>{folderOptions(folderForm.id || undefined)}</select></label>{error && <p role="alert" className="ms-error">{error}</p>}<button disabled={!folderForm.name.trim()}>Save folder</button></fieldset></form></Dialog>}
    {move && <Dialog title={`Move ${move.ids.length} images`} busy={working} close={() => setMove(undefined)}><form onSubmit={e => { e.preventDefault(); void action(async () => { await mobileApi.moveAssets(merchant, environment, move.ids, move.destination || null); setMove(undefined); }); }}><fieldset disabled={blocked}><label>Destination folder<select autoFocus value={move.destination} onChange={e => setMove({ ...move, destination: e.target.value })}>{folderOptions()}</select></label><p>Image links and app references will stay the same.</p>{error && <p role="alert" className="ms-error">{error}</p>}<button>Move images</button></fieldset></form></Dialog>}
    {deleting && <Dialog title="Delete folder" busy={working} close={() => setDeleting(undefined)}><p>Delete “{deleting.name}” and its subfolders? Images will be kept in Unfiled. App references will stay the same.</p>{error && <p role="alert" className="ms-error">{error}</p>}<button disabled={blocked} onClick={() => void action(async () => { await mobileApi.deleteAssetFolder(merchant, environment, deleting.id); navigate('unfiled'); setDeleting(undefined); })}>Delete folder and keep images</button></Dialog>}
    {detail && <Dialog title="Image details" busy={working} close={() => setDetail(undefined)}><img className="ms-media-preview" src={mobileApi.assetUrl(merchant, detail)} alt={detail.name} /><dl><dt>Name</dt><dd>{detail.name}</dd><dt>Dimensions</dt><dd>{detail.width && detail.height ? `${detail.width} × ${detail.height} px` : 'Unavailable'}</dd><dt>Format</dt><dd>{detail.contentType || 'Unavailable'}</dd><dt>Size</dt><dd>{detail.sizeBytes !== null ? `${Math.ceil(detail.sizeBytes / 1024)} KB` : 'Unavailable'}</dd><dt>Folder</dt><dd>{detail.folderId ? trail(detail.folderId).map(f => f.name).join(' / ') : 'Unfiled'}</dd><dt>Usage</dt><dd>{usage(detail)}</dd></dl><button disabled={blocked || detail.kind !== 'image' || detail.id === config.brand.logoAssetId} onClick={() => { selectLogo(detail); setDetail(undefined); }}>Use as logo</button><form onSubmit={e => { e.preventDefault(); void action(async () => { await mobileApi.renameAsset(merchant, environment, detail.id, assetName.trim()); assetChanged({ ...detail, name: assetName.trim() }); setDetail(undefined); }); }}><fieldset disabled={blocked}><label>Image name<input required maxLength={200} value={assetName} onChange={e => setAssetName(e.target.value)} /></label>{error && <p role="alert" className="ms-error">{error}</p>}<button disabled={!assetName.trim()}>Save name</button></fieldset></form></Dialog>}
    {uploadOpen && <Dialog title="Upload images" busy={uploading} close={() => setUploadOpen(false)}><p>Destination: <strong>{current ? trail(current.id).map(f => f.name).join(" / ") : "Unfiled"}</strong></p><p>PNG, JPEG or WebP · up to 5 MiB and 4096 × 4096 px each. Images are sanitized to PNG.</p><form onSubmit={e => { e.preventDefault(); void submit(); }}><fieldset disabled={disabled || uploading}>
      <label className="ms-media-drop" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); if (!disabled && !uploading) selectFiles(Array.from(e.dataTransfer.files)); }}>Drop images here or choose files<input aria-label="Image files" type="file" multiple accept="image/png,image/jpeg,image/webp" onChange={e => { selectFiles(Array.from(e.target.files || [])); e.target.value = ''; }} /></label>
      <div className="ms-media-upload-list">{queue.map((item, i) => <label key={`${item.file.name}-${i}`}>{item.file.name}<input aria-label={`Name for ${item.file.name}`} required maxLength={200} value={item.name} onChange={e => setQueue(previous => previous.map((entry, index) => index === i ? { ...entry, name: e.target.value } : entry))} /></label>)}</div>
      {error && <p role="alert" className="ms-error">{error}</p>}<p role="status">{progress}</p><button disabled={!queue.length || queue.some(item => !item.name.trim())}>{uploading ? 'Uploading…' : `Upload ${queue.length || ''} image${queue.length === 1 ? '' : 's'}`}</button>
    </fieldset></form></Dialog>}
  </section>;
}
