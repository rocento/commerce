import {expect,test} from '@playwright/test';
for(const arabic of [false,true])test(`saved conversations and memory (${arabic?'Arabic':'English'})`,async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.route('https://grocery.rocento.com/api/**',r=>{errors.push('Live request');return r.abort();});
  const t=(en:string,ar:string)=>arabic?ar:en,button=(en:string,ar:string)=>page.getByRole('button',{name:t(en,ar),exact:true}),field=(en:string,ar:string)=>page.getByRole('textbox',{name:t(en,ar),exact:true});
  await page.goto('/');await button('Customer','Customer').click();await expect(page.getByText('12 Garden Street, Cairo',{exact:true})).toBeVisible();
  if(arabic){await page.getByRole('tab',{name:'Account',exact:true}).click();await button('Language','Language').click();await button('العربية','العربية').click();await button('حسابي','حسابي').click();}
  await button('Shopping assistant','مساعد التسوق').click();await button('Conversations & memory','المحادثات والذاكرة').click();
  await field('Search conversations','البحث في المحادثات').fill(t('Weekly','الأسبوع'));await page.getByRole('button',{name:new RegExp(t('Weekly fruit','فاكهة الأسبوع'))}).click();await expect(page.getByText(t('Saved suggestion','اقتراح محفوظ'),{exact:true})).toBeVisible();
  await button('Conversations & memory','المحادثات والذاكرة').click();await page.getByRole('switch',{name:t('Use my saved preferences','استخدام تفضيلاتي المحفوظة'),exact:true}).click();
  await button('Category','الفئة').click();await page.getByRole('menuitem',{name:t('Fresh fruit','الفاكهة'),exact:true}).first().click();await button('Preference','التفضيل').click();await page.getByRole('menuitem',{name:t('Color','لون'),exact:true}).click();
  await field('Preference value','قيمة التفضيل').fill('INTERRUPT');await button('Save preference','حفظ التفضيل').click();await expect(button('Save preference','حفظ التفضيل')).toBeDisabled();
  await button('Refresh conversations & memory','تحديث المحادثات والذاكرة').click();await expect(button('Edit preference','تعديل التفضيل')).toHaveCount(1);
  await button('Edit preference','تعديل التفضيل').click();await field('Preference value','قيمة التفضيل').fill('blue');await button('Update preference','تحديث التفضيل').click();await expect(page.getByText(/blue/)).toBeVisible();
  await button('Export memory','تصدير الذاكرة').click();const downloadPromise=page.waitForEvent('download');await button('Share or download JSON','مشاركة أو تنزيل JSON').click();const download=await downloadPromise;expect(download.suggestedFilename()).toBe('rocento-memory.json');
  await field('Goal name','اسم الهدف').fill('New goal');await button('Rename goal','إعادة تسمية الهدف').click();await button('Archive goal','أرشفة الهدف').click();await expect(button('Continue goal','متابعة الهدف')).toBeDisabled();await button('Unarchive goal','إلغاء أرشفة الهدف').click();await expect(button('Continue goal','متابعة الهدف')).toBeEnabled();
  await button('Delete personal memory','حذف الذاكرة الشخصية').click();await button('Cancel','إلغاء').click();await expect(button('Edit preference','تعديل التفضيل')).toHaveCount(1);
  await button('Delete personal memory','حذف الذاكرة الشخصية').click();await button('Confirm removal','تأكيد الإزالة').click();await expect(button('Edit preference','تعديل التفضيل')).toHaveCount(0);await expect(field('Goal name','اسم الهدف')).toHaveValue('New goal');
  await page.getByRole('switch',{name:t('Use my saved preferences','استخدام تفضيلاتي المحفوظة'),exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:`/tmp/rocento-memory-${arabic?'ar':'en'}.png`});expect(errors).toEqual([]);
});
