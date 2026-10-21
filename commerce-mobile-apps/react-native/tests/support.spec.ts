import {expect,test} from '@playwright/test';

for(const arabic of [false,true]) {
  test(`support lifecycle and retry (${arabic?'Arabic':'English'})`,async({page})=>{
    const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.route('https://grocery.rocento.com/api/**',r=>{errors.push('Live request');return r.abort();});
    const t=(en:string,ar:string)=>arabic?ar:en;
    const button=(en:string,ar:string)=>page.getByRole('button',{name:t(en,ar),exact:true});
    const field=(en:string,ar:string)=>page.getByRole('textbox',{name:t(en,ar),exact:true});
    await page.goto('/');await button('Customer','Customer').click();await expect(page.getByText('12 Garden Street, Cairo',{exact:true})).toBeVisible();await page.getByRole('tab',{name:'Account',exact:true}).click();
    if(arabic){await button('Language','Language').click();await button('العربية','العربية').click();await button('حسابي','حسابي').click();}
    await button('My orders','طلباتي').click();await button('Track order','تتبّع الطلب').click();
    await button('Get help with this order','مساعدة بشأن هذا الطلب').click();await expect(button('Linked order','الطلب المرتبط')).toBeVisible();
    await field('Subject','الموضوع').fill('INTERRUPT');await field('Message','الرسالة').fill('ع'.repeat(1001));await expect(button('Submit ticket','إرسال التذكرة')).toBeDisabled();
    await field('Message','الرسالة').fill(t('Please check the delivery','يرجى التحقق من التوصيل'));await button('Category','الفئة').click();await page.getByRole('menuitem',{name:t('Payment dispute','نزاع دفع'),exact:true}).click();
    await button('Submit ticket','إرسال التذكرة').click();await expect(field('Subject','الموضوع')).not.toBeEditable();await button('Retry saved submission','إعادة محاولة الإرسال المحفوظ').click();
    await expect(page.getByText(t('Support ticket created','تم إنشاء تذكرة الدعم'),{exact:true})).toBeVisible();await expect(page.getByText(t('Open','مفتوحة')+' · '+t('High priority','أولوية عالية')+' · '+t('Payment dispute','نزاع دفع'),{exact:true})).toBeVisible();
    await field('Reply','الرد').fill('INTERRUPT REPLY');await button('Send reply','إرسال الرد').click();await expect(field('Reply','الرد')).not.toBeEditable();
    await button('Refresh ticket','تحديث التذكرة').click();await expect(page.getByTestId(/^support-message-/).filter({hasText:'INTERRUPT REPLY'})).toHaveCount(1);await button('Retry saved reply','إعادة محاولة الرد المحفوظ').click();
    await expect(page.getByText(t('Reply sent','تم إرسال الرد'),{exact:true})).toBeVisible();await expect(page.getByText('INTERRUPT REPLY',{exact:true})).toHaveCount(1);
    await field('Reply','الرد').fill(t('Draft follow-up','مسودة متابعة'));await button('Your tickets','تذاكرك').click();await expect(page.getByRole('button',{name:/#42.*INTERRUPT/})).toHaveCount(1);await page.getByRole('button',{name:/#42.*INTERRUPT/}).click();await expect(field('Reply','الرد')).toHaveValue(t('Draft follow-up','مسودة متابعة'));
    await button('Refresh ticket','تحديث التذكرة').scrollIntoViewIfNeeded();await page.screenshot({path:`/tmp/rocento-support-${arabic?'ar':'en'}.png`});
    await button('Linked order','الطلب المرتبط').click();await expect(button('Get help with this order','مساعدة بشأن هذا الطلب')).toBeVisible();expect(errors).toEqual([]);
  });
  test(`account header omits comparison and support shortcuts (${arabic?'Arabic':'English'})`,async({page})=>{
    const t=(en:string,ar:string)=>arabic?ar:en;const button=(en:string,ar:string)=>page.getByRole('button',{name:t(en,ar),exact:true});
    await page.route('https://grocery.rocento.com/api/**',r=>r.abort());await page.goto('/');await page.getByRole('tab',{name:'Account',exact:true}).click();
    if(arabic){await button('Language','Language').click();await button('العربية','العربية').click();await button('حسابي','حسابي').click();}
    await expect(page.getByRole('heading',{name:t('My account','حسابي'),exact:true})).toBeVisible();
    await expect(button('Support center','مركز الدعم')).toHaveCount(0);
    await expect(page.getByRole('button',{name:/Compare products|مقارنة المنتجات/})).toHaveCount(0);
  });
}
