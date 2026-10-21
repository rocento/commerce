import { useState } from 'react';
import { themeContract, themeTextTranslatable, validThemeValue, type ThemeConfiguration, type ThemeSection, type ThemeTranslation, type PublicLanguages } from '@commerce/api-client';
import { updateThemeTranslation } from './theme-text';
import { themeLabel } from './theme-section-settings';

export function ThemeTranslations({ configuration, disabled, locale, languages, onChange }: {
  configuration: ThemeConfiguration; disabled: boolean; locale: string; languages?: PublicLanguages; onChange: (configuration: ThemeConfiguration) => void;
}) {
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const sections = Object.entries({...configuration.global,...configuration.pages}).flatMap(([layout, sections]) => sections.map(section => ({layout, section:section.component === 'footer_options' ? {...section,settings:{...Object.fromEntries(Object.entries(themeContract.components.footer_options.settings).map(([key,property])=>[key,property.default])),...section.settings}} : section})));
  const options = languages?.languages.filter(language => language.locale !== languages?.source_locale) ?? [];
  const selected = options.find(language => language.locale === locale);
  const missingOptions = ([['top','header_options'],['bottom','footer_options']] as const).filter(([layout, component]) => !configuration.global[layout].some(section => section.component === component));
  function includeDefaults() {
    const global = {...configuration.global};
    for (const [layout, component] of missingOptions) global[layout] = [...global[layout],{id:crypto.randomUUID(),component,version:themeContract.components[component].version,enabled:true,settings:Object.fromEntries(Object.entries(themeContract.components[component].settings).map(([key,property])=>[key,property.default]))}];
    onChange({...configuration,global});
  }
  const fields = sections.flatMap(({layout, section}) => Object.entries(themeContract.components[section.component].settings).filter(([key, property]) => themeTextTranslatable(key, property) && (String(section.settings[key] ?? '').trim() || section.translations?.[locale]?.[key])).map(([key, property]) => {
    const translation = section.translations?.[locale]?.[key];
    const source = String(section.settings[key] ?? '');
    const state = !translation ? 'missing' : translation.source !== source ? 'needs_review' : 'translated';
    return {layout, section, key, property, translation, source, state};
  }));
  function update(section: ThemeSection, key: string, translation?: ThemeTranslation) {
    const replace = (sections: ThemeSection[]) => sections.map(item => item.id === section.id ? updateThemeTranslation({...item,settings:section.settings},locale,key,translation) : item);
    onChange({...configuration, global:{top:replace(configuration.global.top), bottom:replace(configuration.global.bottom)}, pages:Object.fromEntries(Object.entries(configuration.pages).map(([key, items]) => [key, replace(items)])) as ThemeConfiguration['pages']});
  }
  return <section className="theme-translations">
    <h3>Theme translation review</h3>
    <p>Use the Theme language control above to choose a language for every component. Edit text in Sections or review it here. Translations follow this theme’s draft, publication, permissions and rollback. Missing translations use source text. Source changes require review before publishing.</p>
    {missingOptions.length > 0 && <p className="theme-field-help">This theme inherits default {missingOptions.map(([,component])=>component === 'header_options' ? 'header' : 'footer').join(' and ')} text. <button className="text-button" disabled={disabled} onClick={includeDefaults}>Add inherited text to the draft for translation</button></p>}
    {!selected && <p>Select a translation language in the theme toolbar above to review translated text.</p>}
    <div className="theme-translation-toolbar">
      <label className="field">Find component text<input type="search" value={search} onChange={event => setSearch(event.target.value)}/></label>
      <label className="field">Translation status<select value={status} onChange={event => setStatus(event.target.value)}><option value="all">All</option><option value="missing">Missing</option><option value="needs_review">Needs review</option><option value="translated">Translated</option></select></label>
    </div>
    {selected && <><p role="status">{fields.filter(field => field.state === 'translated').length} / {fields.length} translated · {fields.filter(field => field.state === 'missing').length} missing · {fields.filter(field => field.state === 'needs_review').length} need review</p>
      <div className="theme-translation-fields">{fields.filter(field => (status === 'all' || field.state === status) && `${field.layout} ${field.section.id} ${themeContract.components[field.section.component].label} ${field.key} ${field.source} ${field.translation?.value ?? ''}`.toLowerCase().includes(search.toLowerCase())).map(({layout, section, key, property, translation, source, state}) => {
        const invalid = !!translation && (!translation.value.trim() || !validThemeValue(property, translation.value));
        return <fieldset key={`${section.id}:${key}`}><legend>{themeContract.components[section.component].label} · {themeLabel(key)}</legend><p className="muted">{themeLabel(layout)} · {section.id} · {state === 'needs_review' ? 'Needs review' : themeLabel(state)}{!section.enabled ? ' · Section disabled' : ''}</p>
          <label className="field">Source text ({languages?.source_locale})<textarea readOnly value={source} rows={2} dir="auto"/></label>
          {state === 'needs_review' && <p className="theme-field-help">Previously translated source: {translation?.source}</p>}
          <label className="field">{selected.native_name} translation<textarea value={translation?.value ?? ''} rows={(property.max ?? 200) > 500 ? 4 : 2} lang={locale} dir={selected.direction} disabled={disabled} aria-invalid={invalid} onChange={event => update(section, key, event.target.value !== '' ? {source, value:event.target.value} : undefined)}/></label>
          {invalid && <p className="theme-field-error">Use plain text within {property.max ?? 200} UTF-8 bytes.</p>}
          <div className="theme-actions">{state === 'needs_review' && <button className="secondary" disabled={disabled || invalid} onClick={() => update(section,key,{source,value:translation!.value})}>Confirm translation matches source</button>}{translation && <button className="text-button" disabled={disabled} onClick={() => update(section,key)}>Use source fallback</button>}</div>
        </fieldset>;
      })}</div>
    </>}
  </section>;
}
