import logo320 from './brand/rocento-logo-320.webp';
import logo640 from './brand/rocento-logo-640.webp';
import icon96 from './brand/rocento-icon-96.webp';

/** The approved Rocento artwork, shared by every admin and storefront route. */
export function BrandLogo({ iconOnly = false }: { iconOnly?: boolean }) {
  return <img className={iconOnly ? "recento-brand-icon" : "recento-brand-logo"}
    src={iconOnly ? icon96 : logo320}
    srcSet={iconOnly ? undefined : `${logo320} 320w, ${logo640} 640w`}
    sizes={iconOnly ? undefined : '156px'} decoding="async"
    alt="Rocento" width={iconOnly ? 96 : 320} height={iconOnly ? 111 : 77}
    style={{ display: "block", width: iconOnly ? 30 : 156, height: "auto", maxWidth: "100%", flexShrink: 0 }} />;
}
