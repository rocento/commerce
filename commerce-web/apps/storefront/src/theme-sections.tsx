import { PublicationImage, PublicImages } from './public/image';
import React, { createContext, useContext, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { defaultTheme, themeContract, type ThemeConfiguration, type ThemePage, type ThemeSection } from '@commerce/api-client';
import { defaultHero, groceryHeroSizes } from './default-hero';
export const ThemeContext = createContext<ThemeConfiguration>(defaultTheme());
export const useTheme = () => useContext(ThemeContext);
export const CollectionContext = createContext<{ products: (section: ThemeSection) => ReactNode; categories: (section: ThemeSection) => ReactNode }>({ products: () => null, categories: () => null });
type Slots = { header?: ReactNode; navigation?: ReactNode; commerce?: ReactNode; footer?: ReactNode };
type ComponentProps = { section: ThemeSection; slots: Slots };
const string = (s: ThemeSection, key: string) => String(s.settings[key] || '');
function ThemeImage({ section }: ComponentProps) {
  return section.settings.image ? <PublicationImage className="theme-image" id={string(section, 'image')} alt={string(section, 'alt')} /> : null;
}
function Hero({ section: s }: ComponentProps) {
  const published = useContext(PublicImages) !== null;
  const theme = useTheme();
  const grocery = !theme.global.top.some(section => section.enabled && section.component === 'presentation' && ['heritage', 'showcase', 'editorial'].includes(String(section.settings.style)));
  const showAssistant = themeOptions(theme, 'header_options', 'top').show_assistant === 'on';
  const Heading = published ? 'h2' : 'h1';
  return <section className={`theme-hero${grocery ? ' theme-hero--grocery' : ''}`}>
    {s.settings.image ? <PublicationImage id={string(s, 'image')} alt={string(s, 'alt')} sizes={grocery ? groceryHeroSizes : '100vw'} primary /> : !published && <img {...defaultHero} sizes={grocery ? groceryHeroSizes : '100vw'} alt="Fresh Gala apples" fetchPriority="high" decoding="async" width={1254} height={1254} />}
    <div className="theme-hero-copy">
      {grocery && <span className="grocery-hero-eyebrow">Your everyday market</span>}
      <Heading>{string(s, 'heading')}</Heading>
      <p>{string(s, 'text')}</p>
      <div className="theme-hero-actions">
        <Link className="theme-cta" to={string(s, 'href')}>{string(s, 'label')}{grocery && <span className="direction-icon" aria-hidden="true">↗</span>}</Link>
        {grocery && showAssistant && <Link className="grocery-hero-assistant" to="/assistant"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 1.2 4.2L17 9l-3.8 1.8L12 15l-1.2-4.2L7 9l3.8-1.8ZM19 15l.6 1.8 1.9.7-1.9.7L19 20l-.6-1.8-1.9-.7 1.9-.7Z"/></svg>Shop with Assistant</Link>}
      </div>
    </div>
  </section>;
}
function ImageText({ section: s }: ComponentProps) {
  const hero = s.component === 'editorial_hero';
  const theme = useTheme();
  const heritage = theme.global.top.some(section => section.enabled && section.component === 'presentation' && section.settings.style === 'heritage');
  const published = useContext(PublicImages) !== null;
  const Heading = hero && !published ? 'h1' : 'h2';
  return <section className={`theme-editorial ${hero ? 'theme-editorial-hero' : 'theme-editorial-story'}`} data-image-side={s.settings.image_side || 'right'}>
    <div className="theme-editorial-copy"><p className="theme-eyebrow">{string(s, 'eyebrow')}</p><Heading>{string(s, 'heading')}</Heading><p>{string(s, 'text')}</p><Link className="theme-cta" to={string(s, 'href')}>{string(s, 'label')} <span className="direction-icon" aria-hidden="true">↗</span></Link></div>
    {s.settings.image && <PublicationImage id={string(s, 'image')} alt={string(s, 'alt')} sizes={hero && heritage ? '100vw' : '(max-width: 640px) 100vw, 50vw'} primary={hero} />}
  </section>;
}
export function themeOptions(theme: ThemeConfiguration, component: string, location: 'top' | 'bottom') {
  return { ...Object.fromEntries(Object.entries(themeContract.components[component].settings).map(([key, p]) => [key, p.default])), ...theme.global[location].find(s => s.enabled && s.component === component)?.settings };
}
function CoreHeader({ section, slots }: ComponentProps) {
  const options = themeOptions(useTheme(), 'header_options', 'top');
  return <div className="theme-header" data-sticky={options.sticky} data-brand={string(section, 'brand')}>{slots.header}</div>;
}
function CoreFooter({ section, slots }: ComponentProps) {
  const theme = useTheme();
  const options = themeOptions(theme, 'footer_options', 'bottom');
  const brand = String(theme.global.top.find(s => s.component === 'header')?.settings.brand || 'Commerce');
  const value = (key: string) => String(options[key] || '');
  return <footer className="theme-footer theme-footer-core" data-style={value('style')}>
    {options.show_services === 'on' && <div className="footer-services">{[1, 2, 3].map(i => <span key={i}>{value(`service_${i}`)}</span>)}</div>}
    <div className="footer-columns">
      {[1, 2, 3].map(i => <section className="footer-column" key={i}><h2>{value(`column_${i}_heading`)}</h2><nav aria-label={value(`column_${i}_heading`)}>{[1, 2].map(j => value(`column_${i}_link_${j}_label`) && <Link key={j} to={value(`column_${i}_link_${j}_href`)}>{value(`column_${i}_link_${j}_label`)}</Link>)}</nav></section>)}
      {options.show_newsletter === 'on' && <section className="footer-column footer-newsletter"><h2>{value('newsletter_title')}</h2><p>{value('newsletter_text')}</p><Link className="footer-newsletter-link" to={value('newsletter_href')}>{value('newsletter_label')} <span className="direction-icon" aria-hidden="true">↗</span></Link></section>}
    </div>
    {slots.footer && <div className="footer-managed" data-show-brand={options.show_brand}>{slots.footer}</div>}
    {string(section, 'text') !== brand && <p className="footer-description">{string(section, 'text')}</p>}
    <div className="footer-bottom"><span>© {new Date().getFullYear()} {brand}. {value('copyright')}</span><a href="#store-top">{value('back_to_top_label')} <span aria-hidden="true">↑</span></a></div>
  </footer>;
}
const Products = ({ section }: ComponentProps) => <>{useContext(CollectionContext).products(section)}</>;
const Categories = ({ section }: ComponentProps) => <>{useContext(CollectionContext).categories(section)}</>;
const registry: Record<string, React.ComponentType<ComponentProps>> = {
  announcement: ({ section }) => <div className="theme-announcement">{string(section, 'text')}</div>,
  header: CoreHeader,
  header_options: () => null,
  footer_options: () => null,
  navigation: ({ slots }) => <>{slots.navigation}</>,
  hero: Hero,
  editorial_hero: ImageText,
  image_text: ImageText,
  presentation: () => null,
  catalog_filters: () => null,
  product_collection: Products,
  category_showcase: Categories,
  banner: ({ section: s }) => <section className="theme-section theme-banner"><h2>{string(s, 'heading')}</h2><p>{string(s, 'text')}</p><Link to={string(s, 'href')}>{string(s, 'label')}</Link></section>,
  category_grid: Categories,
  featured_products: Products,
  best_sellers: Products,
  recommendations: Products,
  rich_text: ({ section: s }) => <section className="theme-section theme-prose"><h2>{string(s, 'heading')}</h2><p>{string(s, 'text')}</p></section>,
  image: ThemeImage,
  footer: CoreFooter,
  product_grid: ({ slots }) => <>{slots.commerce}</>,
  product_detail: ({ slots }) => <>{slots.commerce}</>,
  cart: ({ slots }) => <>{slots.commerce}</>,
};
class RenderBoundary extends React.Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error) { console.error('theme_render_failure', error); }
  render() { return this.state.failed ? <p role="alert">This section is temporarily unavailable.</p> : this.props.children; }
}
export function ThemeSections({ sections, slots = {} }: { sections: ThemeSection[]; slots?: Slots }) {
  return <>{sections.filter(s => s.enabled).map(s => {
    const definition = themeContract.components[s.component];
    const Component = definition?.version === s.version ? registry[s.component] : undefined;
    return Component ? <RenderBoundary key={s.id}><Component section={s} slots={slots} /></RenderBoundary> : null;
  })}</>;
}
export function ThemeGlobal({ location, ...slots }: Slots & { location: 'top' | 'bottom' }) { return <ThemeSections sections={useTheme().global[location]} slots={slots} />; }
export function ThemePageView({ page, children, heading }: { page: ThemePage; children?: ReactNode; heading?: string }) {
  const theme = useTheme();
  const published = useContext(PublicImages) !== null;
  const sections = theme.pages[page];
  const content = <ThemeSections sections={sections} slots={{ commerce: children }} />;
  const brand = theme.global.top.find(s => s.component === 'header')?.settings.brand || 'Commerce';
  return page === 'home' ? <main className="theme-home">{published && heading && <h1 className="theme-section">{heading}</h1>}{!published && !sections.some(s => s.enabled && ['hero', 'editorial_hero'].includes(s.component)) && <h1 className="theme-section">{String(brand)}</h1>}{content}</main> : <div className="theme-page" data-theme-page={page}>{content}</div>;
}
