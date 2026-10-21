import { useId } from 'react';
import { MediaPicker } from '@commerce/ui';
import { mediaUrl, themeContract, themeTextTranslatable, validThemeValue, type Media, type ThemeProperty, type ThemeSection, type ThemeValue, type StorefrontLanguage } from '@commerce/api-client';
import { updateThemeTranslation } from './theme-text';
import { CategoryPicker } from './category-picker';

export const themeLabel = (value: string) => value.replaceAll('.', ' / ').replaceAll('_', ' ').replace(/\bhref\b/g, 'destination').replace(/\balt\b/g, 'image description');
const fieldLabels: Record<string, string> = { 'font.body': 'Body font', 'font.heading': 'Heading font', 'font.arabic.body': 'Arabic body font', 'font.arabic.heading': 'Arabic heading font', 'layout.direction': 'Text direction', cart_display: 'Cart display', period: 'Sales period', query: 'Search keywords', limit: 'Maximum items', label: 'Button label', image_side: 'Image position' };
const fieldHelp: Record<string, string> = {
  'layout.direction': 'Applies to the entire storefront, including navigation, checkout, and dialogs. Add translated content separately.',
  cart_display: 'Sidebar + cart page opens a quick cart from the storefront header. The full cart page remains available. Defaults to the sidebar.',
  period: 'Ranks units from orders placed in this UTC calendar period that are now delivered or cash collected. Cancelled and incomplete orders do not count.',
  query: 'Optional. Show products matching these keywords within the selected category.',
  limit: 'The maximum number of items to display. Fewer appear when fewer items match.',
  alt: 'Describe the image for people using screen readers. Required when an image is selected.',
};

export function ThemePropertyEditor({ name, property: p, value, onChange, disabled, canReadCatalog = false, required = false }: {
  name: string; property: ThemeProperty; value: ThemeValue; onChange: (value: ThemeValue) => void; disabled: boolean; canReadCatalog?: boolean; required?: boolean;
}) {
  const id = useId();
  const actual = value ?? ((name.startsWith('grid.columns.') || name === 'layout.direction' || name.startsWith('font.arabic.')) ? p.default : value);
  const missingRequired = required && !String(actual ?? '').trim();
  const valid = !missingRequired && validThemeValue(p, actual);
  const displayName = name.startsWith('grid.columns.') ? `Items per row (${name.split('.').at(-1)})` : fieldLabels[name] || themeLabel(name);
  const help = p.kind === 'link' ? 'Use a store path starting with /, or choose a category below.' : fieldHelp[name] || (p.kind === 'number' ? `Enter a whole number from ${p.min ?? 0} to ${p.max ?? 4096}.` : '');
  const error = valid ? '' : missingRequired ? 'Add an image description for accessibility.' : p.kind === 'number' ? `Enter a whole number from ${p.min ?? 0} to ${p.max ?? 4096}.` : p.kind === 'link' ? 'Enter a valid store path, such as /search. External URLs and spaces are not supported.' : p.kind === 'color' ? 'Choose a six-digit hex color.' : p.kind === 'select' ? 'Choose an available option.' : !String(value ?? '').trim() && p.min ? 'This field is required.' : 'Use plain text within the allowed length, without markup or special control characters.';
  const inputProps = { disabled, 'aria-label': displayName, 'aria-invalid': !valid, 'aria-required': required || undefined, 'aria-describedby': help || error ? `${id}-help` : undefined };
  return <div className="theme-property-wrap">
    <label className="field theme-property"><span>{displayName}</span>{p.kind === 'select' ? <select {...inputProps} value={String(value ?? p.default)} onChange={event => onChange(event.target.value)}>{p.options?.map(option => <option key={option} value={option}>{option === 'inherit' && name.startsWith('font.arabic.') ? 'Use theme font (current default)' : option === 'system-ui' ? 'System font' : option === 'rtl' ? 'Right to left (RTL)' : option === 'ltr' ? 'Left to right (LTR)' : option === 'sidebar_and_page' ? 'Sidebar + cart page' : option === 'page_only' ? 'Cart page only' : option === 'on' ? 'Enabled' : option === 'off' ? 'Disabled' : themeLabel(option)}</option>)}</select> : p.kind === 'text' && (p.max || 0) > 500 ? <textarea {...inputProps} rows={4} value={String(value ?? '')} maxLength={p.max ?? undefined} onChange={event => onChange(event.target.value)} /> : <input {...inputProps} type={p.kind === 'color' ? 'color' : p.kind === 'number' ? 'number' : 'text'} value={actual ?? ''} min={p.kind === 'number' ? p.min ?? undefined : undefined} max={p.kind === 'number' ? p.max ?? undefined : undefined} step={p.kind === 'number' ? 1 : undefined} maxLength={p.kind === 'text' ? p.max ?? undefined : undefined} onChange={event => onChange(p.kind === 'number' ? event.target.value === '' ? null : Number(event.target.value) : event.target.value)} />}</label>
    {(help || error) && <small id={`${id}-help`} className={error ? 'theme-field-error' : 'theme-field-help'}>{error || help}</small>}
    {p.kind === 'link' && <details className="theme-link-chooser"><summary>Choose a store destination</summary><div className="theme-link-presets">{[['Home', '/'], ['All products', '/search'], ['Cart', '/cart'], ['Account', '/account']].map(([title, path]) => <button key={path} type="button" className="secondary" disabled={disabled} aria-pressed={value === path} onClick={() => onChange(path)}>{title}</button>)}</div><CategoryPicker label="Category destination" value={/^\/categories\/[^/?#]+$/.test(String(value)) ? String(value).split('/')[2] : ''} matchSlug allowAll={false} canReadCatalog={canReadCatalog} disabled={disabled} onChange={(_id, category) => { if (category) onChange(`/categories/${category.slug}`); }} /></details>}
  </div>;
}

export function ThemeTranslatedProperty({section, name, property, language, disabled, onChange}: {
  section: ThemeSection; name: string; property: ThemeProperty; language: StorefrontLanguage; disabled: boolean; onChange: (section: ThemeSection) => void;
}) {
  const source = String(section.settings[name] ?? '');
  const translation = section.translations?.[language.locale]?.[name];
  const stale = !!translation && translation.source !== source;
  const invalid = !!translation && (!translation.value.trim() || !validThemeValue(property, translation.value));
  return <div className="theme-property-wrap theme-translated-property">
    <label className="field"><span>{themeLabel(name)} · {language.native_name}</span><textarea rows={(property.max ?? 200) > 500 ? 4 : 2} lang={language.locale} dir={language.direction} placeholder={source} value={translation?.value ?? ''} disabled={disabled} aria-invalid={invalid} onChange={event => onChange(updateThemeTranslation(section, language.locale, name, event.target.value === '' ? undefined : {source,value:event.target.value}))}/></label>
    <small className="theme-field-help">Source: <span dir="auto">{source || '(empty)'}</span>{!translation && ' · Uses source fallback'}</small>
    {invalid && <small className="theme-field-error">Use plain text within {property.max ?? 200} UTF-8 bytes.</small>}
    {stale && <small className="theme-field-error">Source changed. Review this translation before publishing.</small>}
    <div className="theme-actions">{stale && <button type="button" className="text-button" disabled={disabled || invalid} onClick={() => onChange(updateThemeTranslation(section,language.locale,name,{source,value:translation!.value}))}>Confirm translation matches source</button>}{translation && <button type="button" className="text-button" disabled={disabled} onClick={() => onChange(updateThemeTranslation(section,language.locale,name))}>Use source fallback</button>}</div>
  </div>;
}

export type ThemeMediaResources = {
  media: Media[];
  mediaLoading: boolean;
  mediaError?: string;
  retryMedia: () => void;
  canReadCatalog: boolean;
};

export function ThemeAssetEditor({ name = 'Section', value, disabled, onChange, resources }: {
  name?: string; value: ThemeValue; disabled: boolean; onChange: (value: ThemeValue, alt?: string) => void; resources: ThemeMediaResources;
}) {
  return <div className="theme-property-wrap"><MediaPicker label={name} value={String(value || '')} disabled={disabled || !resources.canReadCatalog} media={resources.media.filter(item => ['image/png', 'image/jpeg', 'image/webp', 'image/avif'].includes(item.content_type))} loading={resources.mediaLoading && resources.canReadCatalog} error={resources.mediaError} onRetry={resources.retryMedia} imageUrl={mediaUrl} onChange={id => onChange(id || null, resources.media.find(item => item.id === id)?.alt)} />{!resources.canReadCatalog && <small className="theme-field-help">Catalog read permission is required to choose images.</small>}</div>;
}

export function ThemeSectionSettings({ section, disabled, onChange, resources, language, onTranslationChange }: {
  section: ThemeSection; disabled: boolean; onChange: (settings: ThemeSection['settings']) => void; resources: ThemeMediaResources; language?: StorefrontLanguage; onTranslationChange?: (section: ThemeSection) => void;
}) {
  const definition = themeContract.components[section.component];
  const entries = Object.entries(definition.settings);
  const groups: [string, (key: string, property: ThemeProperty) => boolean][] = [
    ['Product source', key => ['category', 'query', 'period'].includes(key)],
    ['Content', key => ['heading', 'text', 'eyebrow', 'brand'].includes(key)],
    ['Image & accessibility', (key, property) => property.kind === 'asset' || ['alt', 'image_side'].includes(key)],
    ['Call to action', (key, property) => property.kind === 'link' || key === 'label'],
    ['Display', () => true],
  ];
  const assigned = new Set<string>();
  const update = (key: string, value: ThemeValue) => onChange({ ...section.settings, [key]: value });
  if (!entries.length) return <p className="theme-field-help">This section uses your store’s live content and has no additional settings.</p>;
  return <div className="theme-section-groups">{groups.map(([title, matches]) => {
    const fields = entries.filter(([key, property]) => !assigned.has(key) && matches(key, property));
    if (title === 'Product source') fields.sort(([a], [b]) => Number(b === 'category') - Number(a === 'category'));
    fields.forEach(([key]) => assigned.add(key));
    if (!fields.length) return null;
    return <fieldset key={title}><legend>{title}</legend><div className="theme-settings">{fields.map(([key, property]) => key === 'category' ? <CategoryPicker key={key} value={String(section.settings[key] || '')} disabled={disabled} canReadCatalog={resources.canReadCatalog} onChange={id => update(key, id)} /> : property.kind === 'asset' ? <ThemeAssetEditor key={key} value={section.settings[key]} disabled={disabled} resources={resources} onChange={(value, alt) => onChange({ ...section.settings, [key]: value, ...(!language && value && alt && !String(section.settings.alt || '').trim() && definition.settings.alt && validThemeValue(definition.settings.alt, alt) ? { alt } : {}) })} /> : language && onTranslationChange && themeTextTranslatable(key, property) ? <ThemeTranslatedProperty key={key} section={section} name={key} property={property} language={language} disabled={disabled} onChange={onTranslationChange}/> : <ThemePropertyEditor key={key} name={key} property={property} value={section.settings[key]} required={key === 'alt' && !!section.settings.image} disabled={disabled} canReadCatalog={resources.canReadCatalog} onChange={value => update(key, value)} />)}</div></fieldset>;
  })}</div>;
}
