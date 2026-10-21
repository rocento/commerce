import { type ThemeSection, type ThemeTranslation } from '@commerce/api-client';

/** Replace one locale override without changing source settings or other locales. */
export function updateThemeTranslation(section: ThemeSection, locale: string, key: string, translation?: ThemeTranslation): ThemeSection {
  const translations = structuredClone(section.translations ?? {});
  const localized = {...translations[locale]};
  if (translation) localized[key] = translation; else delete localized[key];
  if (Object.keys(localized).length) translations[locale] = localized; else delete translations[locale];
  const next = {...section};
  if (Object.keys(translations).length) next.translations = translations; else delete next.translations;
  return next;
}
