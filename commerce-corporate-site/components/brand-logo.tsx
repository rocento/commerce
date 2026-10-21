export function BrandLogo({ iconOnly = false }: { iconOnly?: boolean }) {
  return (
    <span className={iconOnly ? "brand-logo icon-only" : "brand-logo"}>
      <img
        src={iconOnly ? "/brand/recento-icon.png" : "/brand/rocento-logo-a38c4bbbd675-312.webp"}
        srcSet={iconOnly ? undefined : "/brand/rocento-logo-a38c4bbbd675-312.webp 312w, /brand/rocento-logo-a38c4bbbd675-468.webp 468w, /brand/rocento-logo-a38c4bbbd675-624.webp 624w"}
        sizes={iconOnly ? undefined : "156px"}
        alt="Rocento"
        width={iconOnly ? 249 : 2170}
        height={iconOnly ? 288 : 520}
      />
    </span>
  );
}
