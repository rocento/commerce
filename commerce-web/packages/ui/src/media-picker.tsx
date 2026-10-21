import { useEffect, useId, useRef, useState } from "react";
import "./media-picker.css";

type Media = { id: string; alt: string };
function Preview({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  return failed ? <span className="media-picker-unavailable">Preview unavailable</span> : <img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} />;
}

export function MediaPicker({ label, value, onChange, media, imageUrl, required = false, loading = false, disabled = false, error, onRetry }: {
  label: string; value: string; onChange: (value: string) => void; media: Media[];
  imageUrl: (id: string) => string; required?: boolean; loading?: boolean;
  disabled?: boolean; error?: string; onRetry?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [limit, setLimit] = useState(60);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const labelId = useId();
  const titleId = useId();
  const selected = media.find(item => item.id === value);
  const matches = media.filter(item => `${item.alt} ${item.id}`.toLowerCase().includes(search.trim().toLowerCase()));
  useEffect(() => {
    if (!open) return;
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, [open]);
  const close = () => { dialog.current?.close(); setOpen(false); trigger.current?.focus(); };
  return <div className="field visual-media-field" role="group" aria-labelledby={labelId}>
    <span id={labelId}>{label}{required ? " *" : ""}</span>
    <div className="media-picker-selection">
      <button ref={trigger} type="button" className="media-picker-preview" disabled={disabled} aria-label={`Choose ${label.toLowerCase()} image`} aria-haspopup="dialog" onClick={() => { setSearch(""); setLimit(60); setOpen(true); }}>
        {value ? <Preview key={value} src={imageUrl(value)} alt={selected?.alt || `Selected ${label.toLowerCase()}`} /> : <span className="media-picker-placeholder"><span aria-hidden="true">＋</span>Choose an image</span>}
      </button>
      <div className="media-picker-caption"><span>{value ? selected?.alt || "Selected image" : "No image selected"}</span>
        {value && <button type="button" className="secondary" disabled={disabled} onClick={() => onChange("")} aria-label={`Remove ${label.toLowerCase()} image`}>Remove</button>}
      </div>
    </div>
    {open && <dialog ref={dialog} className="media-picker-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); close(); }}>
      <div className="media-picker-header"><div><h2 id={titleId}>Choose {label.toLowerCase()} image</h2><p>Select an image from your media library.</p></div><button type="button" className="secondary" onClick={close} aria-label="Close media picker">✕</button></div>
      <label className="media-picker-search">Search images<input type="search" value={search} placeholder="Search image name…" onChange={event => { setSearch(event.target.value); setLimit(60); }} /></label>
      <p className="media-picker-count" role="status">{loading ? "Loading images…" : `${matches.length} image${matches.length === 1 ? "" : "s"}${search ? " found" : " in library"}`}</p>
      {error && <div className="media-picker-empty" role="alert"><p>Images could not be loaded.</p>{onRetry && <button type="button" className="secondary" onClick={onRetry}>Retry images</button>}</div>}
      <div className="media-picker-gallery" aria-label="Media library">
        {matches.slice(0, limit).map(item => <button type="button" key={item.id} className="media-picker-option" disabled={disabled || !!error || loading} aria-pressed={value === item.id} aria-label={`Select ${item.alt || item.id}`} onClick={() => { onChange(item.id); close(); }}>
          <span className="media-picker-option-image"><Preview src={imageUrl(item.id)} alt={item.alt || "Media image"} />{value === item.id && <span className="media-picker-check" aria-hidden="true">✓</span>}</span>
          <span className="media-picker-option-name">{item.alt || "Untitled image"}</span>
        </button>)}
      </div>
      {!loading && !error && !matches.length && <p className="media-picker-empty">{media.length ? "No images match your search." : "No images in the library yet. Upload images from Catalog → Media."}</p>}
      <div className="media-picker-footer">{matches.length > limit && <button type="button" className="secondary" onClick={() => setLimit(limit + 60)}>Show more images</button>}<button type="button" className="secondary" onClick={close}>Cancel</button></div>
    </dialog>}
  </div>;
}
