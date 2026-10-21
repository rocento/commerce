import { expect, it } from 'vitest';
import { localizedMenuUrl, menuLocale } from './menu-locale';
it('keeps query filters and fragments while replacing the menu language',()=>{
 expect(localizedMenuUrl('/search?q=fruit&lang=en#results','ar')).toBe('/search?q=fruit&lang=ar#results');
 expect(localizedMenuUrl('https://example.com/search?q=fruit','ar')).toBe('https://example.com/search?q=fruit');
});
it('accepts only supported menu languages',()=>{
 expect(menuLocale('ar')).toBe('ar');expect(menuLocale('en')).toBe('en');
 expect(menuLocale('fr')).toBeUndefined();expect(menuLocale(null)).toBeUndefined();
 expect(menuLocale('fr',['en','ar','fr'])).toBe('fr');
 expect(menuLocale('fr',['en','ar'])).toBeUndefined();
});

it('does not normalize a local path into a protocol-relative link',()=>{
 expect(localizedMenuUrl('/a/..//example.com','ar')).toBe('/a/..//example.com?lang=ar');
});
