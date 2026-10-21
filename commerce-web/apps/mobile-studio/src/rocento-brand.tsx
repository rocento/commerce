import logo320 from "../../../packages/ui/src/brand/rocento-logo-320.webp";
import logo640 from "../../../packages/ui/src/brand/rocento-logo-640.webp";

export function RocentoBrand({ studio = false }: { studio?: boolean }) {
  return (
    <a className="ms-brand" href="/" aria-label="Rocento App Studio home">
      <img src={logo320} srcSet={`${logo320} 320w, ${logo640} 640w`} sizes="156px" width={320} height={77} alt="Rocento" />
      {studio && <small>APP STUDIO</small>}
    </a>
  );
}
