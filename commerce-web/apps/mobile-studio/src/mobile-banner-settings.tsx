import { useState } from 'react';
import { mobileApi, type MobileAsset, type MobileSection } from '@commerce/api-client';
import './mobile-banner-settings.css';

type Banner = Extract<MobileSection, { type: 'heroBanner' }>;

export function MobileBannerSettings({ section, merchant, assets, patch }: {
  section: Banner;
  merchant: string;
  assets: MobileAsset[];
  patch: (props: Partial<Banner['props']>) => void;
}) {
  const [confirmSingle, setConfirmSingle] = useState(false);
  const p = section.props;
  const ids = [p.imageAssetId, ...(p.additionalImageAssetIds || [])];
  const available = assets.filter(a => a.verified && a.kind === 'image');
  const unused = available.filter(a => !ids.includes(a.id));
  const carousel = Boolean(p.layout);

  function saveImages(next: string[]) {
    patch({ imageAssetId: next[0], additionalImageAssetIds: next.slice(1) });
  }
  function move(index: number, offset: number) {
    const next = [...ids];
    [next[index], next[index + offset]] = [next[index + offset], next[index]];
    saveImages(next);
  }
  function keepOriginalImage() {
    patch({ layout: undefined, imageFit: undefined, additionalImageAssetIds: undefined });
    setConfirmSingle(false);
  }

  return <div className="ms-banner-settings">
    <label className="ms-field">Banner layout<select aria-label="Banner layout" value={p.layout || 'legacy'} onChange={e => {
      setConfirmSingle(false);
      if (e.target.value === 'legacy') {
        if (ids.length > 1) setConfirmSingle(true);
        else keepOriginalImage();
      } else patch({ layout: e.target.value as 'horizontal' | 'portrait', imageFit: p.imageFit || 'cover' });
    }}><option value="legacy">Original presentation · single image</option><option value="portrait">Tall cards · 2:3</option><option value="horizontal">Wide banners · 3:1</option></select></label>
    {confirmSingle && <div className="ms-banner-confirm" role="group" aria-label="Confirm single image layout">
      <strong>Keep only the first image?</strong>
      <p>Original presentation uses one image. Switching removes the other {ids.length - 1} {ids.length === 2 ? 'slide' : 'slides'} from this section. Your uploaded files stay in Assets.</p>
      <button type="button" className="ms-danger" onClick={keepOriginalImage}>Keep first image only</button>
      <button type="button" onClick={() => setConfirmSingle(false)}>Keep carousel</button>
    </div>}
    <p className="ms-help">{p.layout === 'portrait' ? 'Use portrait artwork, ideally 800 × 1200 px. Three-image carousels open on the middle card.' : p.layout === 'horizontal' ? 'Use wide artwork, ideally 1200 × 400 px. Keep important text away from the edges.' : 'Uses the original native banner presentation. Choose tall cards or wide banners to control cropping and add slides.'}</p>
    {carousel && <label className="ms-field">Image fitting<select aria-label="Image fitting" value={p.imageFit || 'cover'} onChange={e => patch({ imageFit: e.target.value as 'cover' | 'contain' })}><option value="cover">Fill frame (crop edges)</option><option value="contain">Show whole image</option></select><small>{p.imageFit === 'contain' ? 'Keeps the whole artwork visible; empty space may appear around it.' : 'Fills the frame; artwork outside the frame is cropped.'}</small></label>}

    <div className="ms-banner-images-heading"><h4>{carousel ? 'Carousel images' : 'Banner image'}</h4><span>{ids.length} / {carousel ? 8 : 1}</span></div>
    <p className="ms-help">{carousel ? 'Add up to eight images and arrange their order. One image displays as a static banner; multiple images can be swiped.' : 'Choose a verified image from your asset library.'}</p>
    <ol className="ms-banner-image-list" aria-label="Banner images">
      {ids.map((id, index) => {
        const asset = available.find(a => a.id === id);
        const options = available.filter(a => a.id === id || !ids.includes(a.id));
        return <li key={`${id}-${index}`}>
          <div className="ms-banner-image-title"><strong>{carousel ? `Image ${index + 1}` : 'Selected artwork'}</strong>{asset?.width && asset.height ? <small>{asset.width} × {asset.height} px</small> : null}</div>
          <div className="ms-banner-image-choice">
            {asset ? <img src={mobileApi.assetUrl(merchant, asset)} alt="" /> : <span className="ms-banner-image-missing" aria-hidden="true">—</span>}
            <label className="ms-field">{index === 0 ? 'Banner image' : `Slide ${index + 1}`}<select aria-label={index === 0 ? 'Banner image' : `Slide ${index + 1}`} value={id} onChange={e => {
              if (carousel) saveImages(ids.map((value, i) => i === index ? e.target.value : value));
              else patch({ imageAssetId: e.target.value });
            }}>
              {!asset && <option value={id}>Choose a verified image…</option>}
              {options.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select></label>
          </div>
          {!asset && <p className="ms-help" role="status">This image is unavailable or unverified. Choose another image, or upload one in Assets.</p>}
          {carousel && <div className="ms-banner-image-actions">
            <button type="button" aria-label={`Move image ${index + 1} earlier`} disabled={index === 0} onClick={() => move(index, -1)}>↑ Earlier</button>
            <button type="button" aria-label={`Move image ${index + 1} later`} disabled={index === ids.length - 1} onClick={() => move(index, 1)}>↓ Later</button>
            <button type="button" className="ms-danger" aria-label={`Remove image ${index + 1}`} disabled={ids.length === 1} onClick={() => saveImages(ids.filter((_, i) => i !== index))}>Remove</button>
          </div>}
        </li>;
      })}
    </ol>
    {carousel && <>
      <button type="button" className="ms-banner-add" disabled={ids.length >= 8 || unused.length === 0} onClick={() => { if (unused[0]) saveImages([...ids, unused[0].id]); }}>Add carousel image</button>
      <p className="ms-help" role="status">{ids.length >= 8 ? 'Eight-image limit reached.' : unused.length === 0 ? 'Upload another image in Assets to add a slide. Each image can be used once in this carousel.' : `${unused.length} unused ${unused.length === 1 ? 'image available' : 'images available'} in Assets.`}</p>
      <p className="ms-banner-shared-note">All slides share one accessibility description and destination. For different destinations, create separate banner sections. Tall and wide layouts require app runtime 1.3.0.</p>
    </>}
  </div>;
}
