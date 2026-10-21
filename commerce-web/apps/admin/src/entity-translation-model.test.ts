import { expect, it } from 'vitest';
import { translatableEntries, translationComplete, translationField } from './entity-translation-model';
it('omits metadata and orders numbered menu labels naturally', () => {
  const entries=translatableEntries({'__version':'2','item.10.label':'Ten','item.2.label':'Two',title:'Menu'});
  expect(entries.map(([key])=>key)).toEqual(['title','item.2.label','item.10.label']);
  expect(translationField('item.2.link.0.group')?.label).toBe('Menu item 3 · Link 1 · Column heading');
});
it('requires translations for every nonempty text field, excluding metadata', () => {
  const source={__version:'1',title:'Menu','item.0.label':'Shop','item.0.badge':''};
  expect(translationComplete(source,{title:'القائمة','item.0.label':'تسوق'})).toBe(true);
  expect(translationComplete(source,{title:'القائمة','item.0.label':' '})).toBe(false);
});
it('includes text attributes and stable option labels but excludes source label metadata', () => {
  const source = {name:'Ring','attribute.finish':'Polished','__label.attribute.finish':'Finish'};
  expect(translatableEntries(source).map(([key])=>key)).toEqual(['name','attribute.finish']);
  expect(translationComplete(source,{name:'خاتم'})).toBe(false);
  expect(translationComplete(source,{name:'خاتم','attribute.finish':'لامع'})).toBe(true);
  expect(translationField('option.polished.gold')).toMatchObject({multiline:false});
  expect(translationField('price')).toBeNull();
  expect(translationField('description')?.maxLength).toBe(10000);
});
