import { expect, test } from '@playwright/test';

for (const arabic of [false, true]) {
  test(`related products and cart cross-sells (${arabic ? 'Arabic' : 'English'})`, async ({ page }) => {
    const failures: string[] = [];
    page.on('pageerror', error => failures.push(error.message));
    await page.route('https://grocery.rocento.com/api/**', route => { failures.push('Unexpected live request'); return route.abort(); });
    await page.goto('/'); await page.getByRole('button', { name: 'Customer', exact: true }).click();
    await expect(page.getByText('12 Garden Street, Cairo', { exact: true })).toBeVisible();
    if (arabic) {
      await page.getByRole('tab', { name: 'Account', exact: true }).click();
      await page.getByRole('button', { name: 'Language', exact: true }).click();
      await page.getByRole('button', { name: 'العربية', exact: true }).click();
      await page.getByRole('button', { name: 'حسابي', exact: true }).click();
    }
    await page.getByRole('tab', { name: arabic ? 'السلة' : 'Cart', exact: true }).click();
    await expect(page.getByRole('heading', { name: arabic ? 'أكمل طلبك' : 'Complete your order', exact: true })).toBeVisible();
    await page.getByRole('button', { name: arabic ? 'تفاح طازج · 25.00 EGP' : 'Fresh apples · 25.00 EGP', exact: true }).click();
    await expect(page.getByRole('heading', { name: arabic ? 'منتجات ذات صلة' : 'Related products', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: arabic ? 'خيارات أخرى قد تعجبك' : 'More options to consider', exact: true })).toBeVisible();
    await page.getByRole('button', { name: arabic ? 'تفاح — ١ كجم · 25.00 EGP' : 'Apples — 1 kg · 25.00 EGP', exact: true }).last().click();
    await expect(page.getByRole('button', { name: arabic ? 'تفاح طازج · 25.00 EGP' : 'Fresh apples · 25.00 EGP', exact: true }).last()).toBeVisible();
    await page.getByRole('heading', { name: arabic ? 'خيارات أخرى قد تعجبك' : 'More options to consider', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `test-results/relationships-${arabic ? 'ar' : 'en'}.png`, fullPage: true });
    expect(failures).toEqual([]);
  });
  test(`reviewed reorder without placing an order (${arabic ? 'Arabic' : 'English'})`, async ({ page }) => {
    const failures: string[] = [];
    page.on('pageerror', error => failures.push(error.message));
    await page.route('https://grocery.rocento.com/api/**', route => { failures.push('Unexpected live request'); return route.abort(); });
    await page.goto('/');
    await page.getByRole('button', { name: 'Customer', exact: true }).click();
    await expect(page.getByText('12 Garden Street, Cairo', { exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'Account', exact: true }).click();
    if (arabic) {
      await page.getByRole('button', { name: 'Language', exact: true }).click();
      await page.getByRole('button', { name: 'العربية', exact: true }).click();
      await page.getByRole('button', { name: 'حسابي', exact: true }).click();
    }
    const label = (en: string, ar: string) => arabic ? ar : en;
    const button = (en: string, ar: string) => page.getByRole('button', { name: label(en, ar), exact: true });
    await button('My orders', 'طلباتي').click();
    await button('Track order', 'تتبّع الطلب').click();
    await expect(page.getByText(label('Gift message: Happy birthday', 'رسالة الهدية: هدية سعيدة'), { exact: true })).toBeVisible();
    await expect(page.getByText(label('Line discount: 2.00 EGP', 'خصم المنتج: 2.00 EGP'), { exact: true })).toBeVisible();
    await button('Reorder', 'إعادة الطلب').click();
    await expect(button('Keep cart & review reorder', 'الاحتفاظ بالسلة ومراجعة إعادة الطلب')).toBeDisabled();
    await button('12 Garden Street, Cairo', '١٢ شارع الحديقة، القاهرة').click();
    if (arabic) await page.getByRole('switch', { name: 'استبدال السلة الحالية', exact: true }).click();
    await button(arabic ? 'Empty cart & review reorder' : 'Keep cart & review reorder', arabic ? 'إفراغ السلة ومراجعة إعادة الطلب' : 'الاحتفاظ بالسلة ومراجعة إعادة الطلب').click();
    await expect(page.getByText(label('Review proposed basket', 'مراجعة السلة المقترحة'), { exact: true })).toBeVisible();
    await button('Increase quantity', 'زيادة الكمية').click();
    await expect(button('Approve & apply to bag', 'الموافقة والتطبيق على السلة')).toBeEnabled();
    await page.screenshot({ path: `test-results/reorder-${arabic ? 'ar' : 'en'}.png`, fullPage: true });
    await button('Approve & apply to bag', 'الموافقة والتطبيق على السلة').click();
    await expect(page.getByText(label('Your reorder cart is ready', 'سلة إعادة الطلب جاهزة'), { exact: true })).toBeVisible();
    await button('Reload reorder', 'إعادة تحميل إعادة الطلب').click();
    await expect(page.getByText(label('Your reorder cart is ready', 'سلة إعادة الطلب جاهزة'), { exact: true })).toBeVisible();
    await expect(button('Place order', 'تأكيد الطلب')).toHaveCount(0);
    expect(failures).toEqual([]);
  });
  test(`coupon apply, reject, remove and fresh quote (${arabic ? 'Arabic' : 'English'})`, async ({ page }) => {
    const failures: string[] = [];
    page.on('pageerror', error => failures.push(error.message));
    await page.route('https://grocery.rocento.com/api/**', route => { failures.push('Unexpected live request'); return route.abort(); });
    await page.goto('/');
    await page.getByRole('button', { name: 'Customer', exact: true }).click();
    await expect(page.getByText('12 Garden Street, Cairo', { exact: true })).toBeVisible();
    if (arabic) {
      await page.getByRole('tab', { name: 'Account', exact: true }).click();
      await page.getByRole('button', { name: 'Language', exact: true }).click();
      await page.getByRole('button', { name: 'العربية', exact: true }).click();
      await page.getByRole('button', { name: 'حسابي', exact: true }).click();
    }
    const label = (en: string, ar: string) => arabic ? ar : en;
    const button = (en: string, ar: string) => page.getByRole('button', { name: label(en, ar), exact: true });
    await page.getByRole('tab', { name: label('Cart', 'السلة'), exact: true }).click();
    await button('Offers & promo codes', 'العروض وأكواد الخصم').click();
    const input = page.getByRole('textbox', { name: label('Promo code', 'كود الخصم'), exact: true });
    await expect(button('Apply code', 'تطبيق الكود')).toBeDisabled();
    await input.fill('BAD'); await button('Apply code', 'تطبيق الكود').click();
    await expect(page.getByText(label('This code is not valid', 'هذا الكود غير صالح'), { exact: true }).last()).toBeVisible();
    await input.fill(' SAVE5 '); await button('Apply code', 'تطبيق الكود').click();
    await expect(page.getByText(label('Current code: SAVE5', 'الكود الحالي: SAVE5'), { exact: true })).toBeVisible();
    await page.screenshot({ path: `test-results/coupon-form-${arabic ? 'ar' : 'en'}.png`, fullPage: true });
    await input.fill('OFFLINE'); await button('Apply code', 'تطبيق الكود').click();
    await expect(page.getByText(label('Unable to connect. Check your connection and retry.', 'تعذر الاتصال. تحقق من اتصالك وحاول مرة أخرى.'), { exact: true }).last()).toBeVisible();
    await expect(button('Apply code', 'تطبيق الكود')).toBeEnabled();
    await expect(page.getByLabel(label('Updating', 'جارٍ حفظ التغييرات'), { exact: true })).toHaveCount(0);
    await expect(page.getByText(label('Current code: SAVE5', 'الكود الحالي: SAVE5'), { exact: true })).toBeVisible();
    await button('Done', 'تم').click();
    await button('Continue to checkout', 'متابعة لإتمام الشراء').click();
    await button('Find delivery times', 'عرض المواعيد').click();
    await button('Review total', 'مراجعة الإجمالي').click();
    await expect(button('Place order', 'تأكيد الطلب')).toBeVisible();
    await button('Offers & promo codes', 'العروض وأكواد الخصم').last().click();
    await button('Remove code', 'إزالة الكود').click();
    await expect(button('Remove code', 'إزالة الكود')).toHaveCount(0);
    await button('Done', 'تم').click();
    await button('Continue to checkout', 'متابعة لإتمام الشراء').click();
    await expect(button('Place order', 'تأكيد الطلب')).toHaveCount(0);
    await button('Find delivery times', 'عرض المواعيد').click();
    await button('Review total', 'مراجعة الإجمالي').click();
    await expect(button('Place order', 'تأكيد الطلب')).toBeVisible();
    await page.screenshot({ path: `test-results/coupon-${arabic ? 'ar' : 'en'}.png`, fullPage: true });
    expect(failures).toEqual([]);
  });
  test(`checkout review, edit and confirmation (${arabic ? 'Arabic' : 'English'})`, async ({ page }) => {
    const failures: string[] = [];
    page.on('pageerror', error => failures.push(error.message));
    await page.route('https://grocery.rocento.com/api/**', route => { failures.push('Unexpected live request'); return route.abort(); });
    await page.goto('/');
    await page.getByRole('button', { name: 'Customer', exact: true }).click();
    await expect(page.getByText('12 Garden Street, Cairo', { exact: true })).toBeVisible();
    if (arabic) {
      await page.getByRole('tab', { name: 'Account', exact: true }).click();
      await page.getByRole('button', { name: 'Language', exact: true }).click();
      await page.getByRole('button', { name: 'العربية', exact: true }).click();
      await page.getByRole('button', { name: 'حسابي', exact: true }).click();
    }
    await page.getByRole('tab', { name: arabic ? 'السلة' : 'Cart', exact: true }).click();
    await page.getByRole('button', { name: arabic ? 'متابعة لإتمام الشراء' : 'Continue to checkout', exact: true }).click();
    await page.getByRole('button', { name: arabic ? 'عرض المواعيد' : 'Find delivery times', exact: true }).click();
    const gift = page.getByRole('textbox', { name: arabic ? 'رسالة هدية (اختياري)' : 'Gift message (optional)', exact: true });
    await gift.fill('ع'.repeat(251));
    await expect(page.getByRole('button', { name: arabic ? 'مراجعة الإجمالي' : 'Review total', exact: true })).toBeDisabled();
    const message = arabic ? 'هدية سعيدة' : 'Happy birthday';
    await gift.fill(message);
    await page.getByRole('button', { name: arabic ? 'مراجعة الإجمالي' : 'Review total', exact: true }).click();
    await expect(page.getByText((arabic ? 'رسالة الهدية: ' : 'Gift message: ') + message, { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: arabic ? 'تأكيد الطلب' : 'Place order', exact: true })).toBeVisible();
    await page.getByRole('button', { name: arabic ? 'تعديل التوصيل' : 'Edit delivery', exact: true }).click();
    await expect(gift).toHaveValue(message);
    await expect(page.getByRole('button', { name: arabic ? 'تأكيد الطلب' : 'Place order', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: arabic ? 'مراجعة الإجمالي' : 'Review total', exact: true }).click();
    await page.getByRole('button', { name: arabic ? 'تأكيد الطلب' : 'Place order', exact: true }).click();
    await expect(page.getByText(arabic ? 'تم تأكيد الطلب' : 'Order confirmed', { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: arabic ? 'تأكيد الطلب' : 'Place order', exact: true })).toHaveCount(0);
    expect(failures).toEqual([]);
  });
}
