import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { catalogApi, mediaUrl, type Media } from "@commerce/api-client";
import { Notice, useAction } from "@commerce/ui";
import "./product-images.css";

const MAX_IMAGES = 10;
function ImageCard({ id, media, index, total, onChange, disabled }: { id: string; media?: Media; index: number; total: number; onChange: (action: "cover" | "left" | "right" | "remove") => void; disabled?: boolean }) {
  return <article className="product-image-card"><img src={mediaUrl(id)} alt={media?.alt || `Product image ${index + 1}`} /><div><strong>{index === 0 ? "Cover image" : `Image ${index + 1}`}</strong><p>{media?.alt || "Selected product image"}</p><div className="product-image-actions"><button type="button" className="secondary" disabled={disabled || index === 0} onClick={() => onChange("cover")}>Make cover</button><button type="button" className="secondary" aria-label={`Move image ${index+1} earlier`} disabled={disabled || index === 0} onClick={() => onChange("left")}>←</button><button type="button" className="secondary" aria-label={`Move image ${index+1} later`} disabled={disabled || index === total - 1} onClick={() => onChange("right")}>→</button><button type="button" className="text-button" disabled={disabled} onClick={() => onChange("remove")}>Remove</button></div></div></article>;
}
export function ProductImages({ ids, onChange, disabled }: { ids: string[]; onChange: (ids: string[]) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const media = useQuery({ queryKey: ["catalog", "media"], queryFn: catalogApi.mediaList });
  function change(index: number, action: "cover" | "left" | "right" | "remove") {
    const next = [...ids], id = next[index];
    if (action === "remove") next.splice(index, 1);
    else if (action === "cover") { next.splice(index, 1); next.unshift(id); }
    else { const to = index + (action === "left" ? -1 : 1); [next[index], next[to]] = [next[to], next[index]]; }
    onChange(next);
  }
  return <section className="product-images"><div className="product-images-heading"><div><h3>Images & media</h3><p className="help">{ids.length} / {MAX_IMAGES} images. The first image is the cover. Save the product to apply gallery changes.</p></div><button type="button" className="secondary" disabled={disabled} onClick={() => setOpen(true)}>Add images</button></div><Notice error>{media.error?.message}</Notice><div className="product-image-gallery">{ids.map((id, index) => <ImageCard key={id} id={id} index={index} total={ids.length} media={media.data?.find(m => m.id === id)} onChange={action => change(index, action)} disabled={disabled}/>)}</div>{!ids.length && <p className="product-images-empty">No product images yet. Add images from the media library or upload a new image.</p>}{open && <MediaDialog ids={ids} close={() => setOpen(false)} apply={next => { onChange(next); setOpen(false); }}/>}</section>;
}
function MediaDialog({ ids, close, apply }: { ids: string[]; close: () => void; apply: (ids: string[]) => void }) {
  const ref = useRef<HTMLDialogElement>(null), fileInput = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState(ids), [search, setSearch] = useState(""), [file, setFile] = useState<File | null>(null), [alt, setAlt] = useState("");
  const upload = useAction(), cache = useQueryClient();
  const media = useQuery({ queryKey: ["catalog", "media"], queryFn: catalogApi.mediaList });
  useEffect(() => { const dialog = ref.current!; dialog.showModal(); return () => dialog.close(); }, []);
  const rows = media.data?.filter(m => m.content_type.startsWith("image/") && `${m.alt} ${m.id}`.toLowerCase().includes(search.toLowerCase())) || [];
  return createPortal(<dialog ref={ref} className="product-media-dialog" aria-labelledby="product-media-title" onCancel={e => { e.preventDefault(); if (!upload.busy) close(); }}><div className="product-images-heading"><div><h2 id="product-media-title">Select product images</h2><p>Choose existing media or upload an image. Up to {MAX_IMAGES} images per product.</p></div><button type="button" className="secondary" disabled={upload.busy} onClick={close}>Cancel</button></div>
    <Notice error>{media.error?.message || upload.error}</Notice>
    <details className="product-media-upload"><summary>Upload a new image</summary><p>PNG, JPEG or WebP · up to 5 MB per image</p><label className="field">Image file<input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" disabled={upload.busy} onChange={e => setFile(e.target.files?.[0] || null)}/></label><label className="field">Image description<input maxLength={300} value={alt} disabled={upload.busy} onChange={e => setAlt(e.target.value)}/></label><button type="button" disabled={!file || !alt.trim() || upload.busy || selected.length >= MAX_IMAGES} onClick={() => void upload.run(async () => { if (!file || !["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 5 * 1024 * 1024) throw new Error("Choose a PNG, JPEG or WebP image no larger than 5 MB."); const m = await catalogApi.upload(file, alt.trim()); setSelected(current => [...current, m.id]); setFile(null); setAlt(""); if (fileInput.current) fileInput.current.value = ""; await cache.invalidateQueries({ queryKey: ["catalog", "media"] }); })}>{upload.busy ? "Uploading…" : "Upload & select"}</button></details>
    <label className="field">Search media<input type="search" placeholder="Search by image description" value={search} onChange={e => setSearch(e.target.value)}/></label><p role="status">{selected.length} / {MAX_IMAGES} selected{selected.length >= MAX_IMAGES ? " · Remove an image to choose another." : ""}</p>
    {media.isPending ? <p role="status">Loading media…</p> : <div className="product-media-library">{rows.map(m => <label key={m.id} className={selected.includes(m.id) ? "chosen" : ""}><img loading="lazy" src={mediaUrl(m.id)} alt={m.alt}/><span><input type="checkbox" aria-label={m.alt || "Untitled image"} disabled={upload.busy || (!selected.includes(m.id) && selected.length >= MAX_IMAGES)} checked={selected.includes(m.id)} onChange={e => setSelected(current => e.target.checked ? [...current, m.id] : current.filter(id => id !== m.id))}/>{m.alt || "Untitled image"}</span></label>)}</div>}
    {!media.isPending && !media.error && !rows.length && <p>No images match your search.</p>}
    <div className="product-media-footer"><span>Uploaded files remain in the media library.</span><button type="button" disabled={upload.busy} onClick={() => apply(selected)}>Add selected images ({selected.length})</button></div>
  </dialog>, document.body);
}
