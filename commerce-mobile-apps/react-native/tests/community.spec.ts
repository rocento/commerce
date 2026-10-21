import { expect, test } from '@playwright/test';

for (const arabic of [false,true]) {
  test(`comparison and moderated reviews (${arabic?'Arabic':'English'})`,async({page})=>{
    const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('https://grocery.rocento.com/api/**',route=>{errors.push('Unexpected live request');return route.abort();});
    const t=(en:string,ar:string)=>arabic?ar:en;
    const button=(en:string,ar:string)=>page.getByRole('button',{name:t(en,ar),exact:true});
    await page.goto('/');await button('Customer','Customer').click();await expect(page.getByText('12 Garden Street, Cairo',{exact:true})).toBeVisible();
    if(arabic){await page.getByRole('tab',{name:'Account',exact:true}).click();await button('Language','Language').click();await button('العربية','العربية').click();await button('حسابي','حسابي').click();}
    await page.getByRole('tab',{name:t('Cart','السلة'),exact:true}).click();
    await button('Fresh apples · 25.00 EGP','تفاح طازج · 25.00 EGP').click();
    await button('Compare this product','مقارنة هذا المنتج').click();
    await button('Apples — 1 kg · 25.00 EGP','تفاح — ١ كجم · 25.00 EGP').last().click();
    await button('Compare this product','مقارنة هذا المنتج').click();
    await button('Compare products (2/5)','مقارنة المنتجات (2/5)').click();
    await expect(page.getByText(t('Choose options for pricing','اختر الخيارات لمعرفة السعر'),{exact:true})).toBeVisible();
    await expect(button('Ask the shopping assistant','اسأل مساعد التسوق')).toBeVisible();
    await page.screenshot({path:`/tmp/rocento-comparison-${arabic?'ar':'en'}.png`});
    await button('Ask the shopping assistant','اسأل مساعد التسوق').click();
    await expect(page.getByRole('textbox',{name:t('Ask your shopping assistant','اسأل مساعد التسوق'),exact:true})).toHaveValue(/Compare these products:.*\/products\//);
    await button('Done','تم').click();
    await page.getByRole('tab',{name:t('Cart','السلة'),exact:true}).click();
    await button('Fresh apples · 25.00 EGP','تفاح طازج · 25.00 EGP').click();
    await page.getByRole('textbox',{name:t('Public display name','الاسم المعروض'),exact:true}).fill('Mona');
    await page.getByRole('textbox',{name:t('Review title','عنوان التقييم'),exact:true}).fill('INTERRUPT');
    const body=page.getByRole('textbox',{name:t('Your review','تقييمك'),exact:true});
    await body.fill('ع'.repeat(2001));await expect(button('Submit for moderation','إرسال للمراجعة')).toBeDisabled();
    await body.fill(t('Good quality','جودة جيدة'));await button('Submit for moderation','إرسال للمراجعة').click();
    await expect(button('Submit for moderation','إرسال للمراجعة')).toBeDisabled();
    await button('Refresh reviews','تحديث التقييمات').click();
    await expect(page.getByText(t('Pending approval','بانتظار الموافقة'),{exact:true})).toBeVisible();
    await page.getByRole('textbox',{name:t('Review title','عنوان التقييم'),exact:true}).fill(t('Fresh delivery','توصيل طازج'));
    await button('Submit for moderation','إرسال للمراجعة').click();
    await expect(page.getByText(t('Review submitted for moderation','تم إرسال التقييم للمراجعة'),{exact:true})).toBeVisible();
    await button('Submit for moderation','إرسال للمراجعة').scrollIntoViewIfNeeded();
    await page.screenshot({path:`/tmp/rocento-reviews-${arabic?'ar':'en'}.png`});
    expect(errors).toEqual([]);
  });
}
