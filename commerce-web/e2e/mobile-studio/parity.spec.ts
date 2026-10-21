import { test, expect } from '@playwright/test';
import { setup } from './parity-fixture';
for(const target of ['ios-swift','android-kotlin','ios-react-native','android-react-native']) test(`screen parity evidence ${target}`,async({page})=>{
 const state=await setup(page);
 for(const draft of Object.values(state.drafts)) {
  draft.config.navigation.tabs=['home','categories','deals','account','cart'];
  draft.config.compatibility.minIosRuntime='1.2.0'; draft.config.compatibility.minAndroidRuntime='1.2.0';
  draft.config.brand.light={primary:'#063C22',onPrimary:'#FFFFFF',background:'#FFFFFF',surface:'#F1F4F0',text:'#17251D'};
  draft.config.brand.radiusToken='small'; draft.config.brand.density='comfortable';
 }
 await page.reload(); await page.getByLabel('Preview app').selectOption(target);
 const d=page.getByTestId(target.startsWith('ios')?'preview-iOS':'preview-Android');
 const shot=async(name:string)=>{await d.locator('.ms-phone').screenshot({path:`../output/preview-variants-parity-20261013/preview/${target}-${name}.png`});};
 await expect(d.getByRole('button',{name:'View Red grapes'})).toBeVisible(); await shot('home');
 for(const tab of ['Categories','Deals']) {await d.getByRole('button',{name:tab,exact:true}).click();await shot(tab.toLowerCase());}
 await d.getByRole('button',{name:'Categories',exact:true}).click();
 await d.getByRole('button',{name:'Fresh fruit',exact:true}).click(); await shot('category-results');
 await d.getByRole('button',{name:'Filter & sort',exact:true}).click();
 await d.getByLabel('Min price',{exact:true}).fill('2');await shot('filters');
 await d.getByRole('button',{name:'Done',exact:true}).click();
 await d.getByRole('button',{name:'Filter & sort',exact:true}).click();await expect(d.getByLabel('Min price',{exact:true})).toHaveValue('');
 await d.getByRole('button',{name:'Show results',exact:true}).click();
 await d.getByRole('button',{name:'View Red grapes'}).click();
 await d.getByRole('button',{name:'Increase quantity'}).click();await expect(d.getByLabel('Current quantity')).toHaveText('2');
 const before=await d.locator('.ms-purchase-bar').boundingBox();
 await d.locator('.ms-sheet-content').evaluate(e=>{e.scrollTop=e.scrollHeight;});
 const after=await d.locator('.ms-purchase-bar').boundingBox();expect(after!.y).toBe(before!.y);
 await d.locator('.ms-sheet-content').evaluate(e=>{e.scrollTop=0;}); await shot('product-quantity');
 await d.getByRole('button',{name:'Add to cart',exact:true}).click();await expect(d.locator('.ms-added-to-cart')).toContainText('In cart: 2');
 await d.getByRole('button',{name:'View cart',exact:true}).click();await shot('cart');
 await d.getByRole('button',{name:'Account',exact:true}).click();await shot('account');
 await d.locator('.ms-account-shortcuts').getByRole('button',{name:/^Wishlist/}).click();await shot('wishlist');
 await d.getByRole('button',{name:'Account',exact:true}).click();await d.locator('.ms-account-shortcuts').getByRole('button',{name:/^Addresses/}).click();await shot('addresses');
 for(const [button,screen] of [['App settings','settings'],['Notifications','notifications'],['Help & support','help'],['Contact us','contact'],['About us','about'],['Privacy policy','privacy'],['Terms & conditions','terms']]) {await d.getByRole('button',{name:'Account',exact:true}).click();await d.getByRole('button',{name:button,exact:true}).click();await shot(screen);}
 await d.getByRole('button',{name:'Account',exact:true}).click();await d.locator('.ms-account-shortcuts').getByRole('button',{name:/^Orders/}).click();await shot('orders');
 await d.getByRole('button',{name:'Home',exact:true}).click();await d.getByRole('button',{name:'Shopping assistant',exact:true}).click();await shot('assistant');
 await d.getByRole('button',{name:'Help me choose a product',exact:true}).click();await shot('assistant-conversation');
 await d.getByRole('button',{name:'Done',exact:true}).click();await d.getByRole('button',{name:'Shopping assistant',exact:true}).click();await expect(d.getByText('Preview response · Explore these catalog products.')).toBeVisible();await d.getByRole('button',{name:'Done',exact:true}).click();
 await page.getByLabel('Preview language').selectOption('ar');await page.getByLabel('Device width').selectOption('320');
 await d.getByRole('button',{name:'عرض عنب أحمر'}).click();await shot('product-ar');
 expect(await d.locator('.ms-sheet-content').evaluate(e=>e.scrollWidth<=e.clientWidth)).toBe(true);
 expect(state.writes).toBe(0);
});
