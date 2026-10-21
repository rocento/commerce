import { useInterface } from './interface-locale';
import { useTheme } from './themes';

export function ProductLoading({ contentOnly = false }: { contentOnly?: boolean }) {
  const { t: ui } = useInterface();
  const theme = useTheme();
  const style = theme.global.top.find(s => s.enabled && s.component === "presentation")?.settings.style;
  const heritage = style === "heritage";
  const content = <div className="product-loading" role="status" aria-label={ui("storefront.loading_product", "Loading product")} aria-busy="true">
    {!heritage && <div className="breadcrumbs" aria-hidden="true"><span className="product-skeleton-line" /></div>}
    <div className={`product-detail${heritage ? "" : " product-detail-grocery"}`} aria-hidden="true">
      <div className="product-media-panel"><div className="detail-image product-skeleton" /><div className="product-skeleton-thumbnails" /></div>
      <div className="product-summary"><div className="product-skeleton-line" /><div className="product-skeleton-title" /><div className="product-skeleton-copy" /></div>
      {!heritage && <div className="purchase-panel"><div className="purchase-card product-skeleton-purchase" /></div>}
    </div>
  </div>;
  return contentOnly ? content : <main className={`product-main${!heritage && style !== "showcase" ? " product-main-grocery" : ""}`}>{content}</main>;
}

