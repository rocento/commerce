import { expect, test } from '@playwright/test';
test('deals, saved products and assistant complete the customer journey', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('https://grocery.rocento.com/api/**', route => { errors.push('Unexpected live network request'); return route.abort(); });
  await page.goto('/'); await page.getByRole('button', { name: 'Customer', exact: true }).click(); await expect(page.getByText('12 Garden Street, Cairo', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Deals', exact: true }).click();
  await expect(page.getByText(/Save.*5\.00/)).toBeVisible();
  await page.getByRole('button', { name: 'Fresh apples', exact: true }).click();
  await page.getByRole('button', { name: 'Save to wishlist', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('Saved to wishlist', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('tab', { name: 'Account', exact: true }).click();
  await page.getByRole('button', { name: 'Wishlist', exact: true }).click();
  await expect(page.getByText('2 saved products')).toBeVisible();
  await page.getByRole('button', { name: 'Remove from wishlist', exact: true }).first().click();
  await expect(page.getByText('1 saved products')).toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('tab', { name: 'Cart', exact: true }).click();
  await page.getByRole('button', { name: 'Save for later', exact: true }).click();
  await expect(page.getByText('Your bag is empty')).toBeVisible();
  await page.getByRole('tab', { name: 'Account', exact: true }).click();
  await page.getByRole('button', { name: 'Shopping assistant', exact: true }).click();
  for (const name of ['Where is my last order?', 'Recommended today', 'Show my tickets', 'Find best sellers', 'Best discounts today', 'Best value items']) {
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  }
  await page.screenshot({ path: testInfo.outputPath('assistant-suggestions-en.png'), fullPage: true });
  await page.getByRole('button', { name: 'Show my tickets', exact: true }).click();
  await expect(page.getByText('No support tickets yet', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Shopping assistant', exact: true }).click();
  await page.getByRole('button', { name: 'Find best sellers', exact: true }).click();
  await expect(page.getByText('Recommend best-selling products', { exact: true })).toBeVisible();
  await expect(page.getByText('Picked for you')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop response' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Shopping assistant', exact: true }).click();
  await expect(page.getByText('Picked for you')).toBeVisible();
  await page.getByRole('textbox', { name: 'Ask your shopping assistant', exact: true }).fill('proposal');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByText('Review proposed basket')).toBeVisible();
  const approve = page.getByRole('button', { name: 'Approve & apply to bag' }); await expect(approve).toBeEnabled(); await approve.click();
  await expect(page.getByText('Applied to your bag. Review checkout separately to place your order.')).toBeVisible();
  await page.getByRole('button', { name: 'Chat options', exact: true }).click(); await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await page.getByRole('textbox', { name: 'Ask your shopping assistant', exact: true }).fill('interrupt');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByText(/Response interrupted/)).toBeVisible();
  expect(errors).toEqual([]);
});
test('guest, empty, Arabic and narrow screens are usable', async ({ page }, testInfo) => {
  await page.goto('/'); await page.getByRole('tab', { name: 'Account', exact: true }).click();
  await page.getByRole('button', { name: 'Wishlist', exact: true }).click();
  await expect(page.getByText('Sign in to save your favourites and find them here.')).toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Shopping assistant', exact: true }).click();
  await page.getByRole('button', { name: 'Show my tickets', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in to view your tickets', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await page.getByRole('button', { name: 'Empty', exact: true }).click();
  await page.getByRole('tab', { name: 'Deals', exact: true }).click();
  await expect(page.getByText('No deals available right now')).toBeVisible();
  await page.getByRole('tab', { name: 'Account', exact: true }).click(); await page.getByRole('button', { name: 'Language', exact: true }).click(); await page.getByRole('button', { name: 'العربية', exact: true }).click(); await page.getByRole('button', { name: 'حسابي', exact: true }).click();
  await page.getByRole('tab', { name: 'العروض', exact: true }).click();
  await expect(page.getByText('لا توجد عروض حالياً')).toBeVisible();
  await page.setViewportSize({ width: 320, height: 740 });
  await page.getByRole('tab', { name: 'الحساب', exact: true }).click();
  await page.getByRole('button', { name: 'المفضلة', exact: true }).click();
  await expect(page.getByText('المفضلة فارغة. احفظ منتجاً من صفحة تفاصيله.')).toBeVisible();
  await page.screenshot({ path: 'test-results/wishlist-ar-narrow.png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'تم', exact: true }).click();
  await page.getByRole('button', { name: 'مساعد التسوق', exact: true }).click();
  for (const name of ['أين طلبي الأخير؟', 'ترشيحات اليوم', 'اعرض تذاكري', 'الأكثر مبيعاً', 'أفضل خصومات اليوم', 'أفضل المنتجات قيمة']) {
    await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  }
  await page.screenshot({ path: testInfo.outputPath('assistant-suggestions-ar.png'), fullPage: true });
  await page.getByRole('button', { name: 'اعرض تذاكري', exact: true }).click();
  await expect(page.getByText('لا توجد تذاكر دعم بعد', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'تم', exact: true }).click();
  await page.getByRole('button', { name: 'مساعد التسوق', exact: true }).click();
  await page.getByRole('button', { name: 'الأكثر مبيعاً', exact: true }).click();
  await expect(page.getByText('رشّح لي المنتجات الأكثر مبيعاً', { exact: true })).toBeVisible();
  await expect(page.getByText('اختيارنا لك')).toBeVisible();
  await page.screenshot({ path: 'test-results/assistant-ar-narrow.png' });
});
test('category filter drafts reset, cancel, validate and apply with a fixed action', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('tab', {name:'Categories',exact:true}).click();
  await page.getByRole('button', {name:'Filter & sort',exact:true}).click();
  await page.getByRole('radio', {name:'Price: high to low',exact:true}).click();
  const minimum = page.getByRole('slider', {name:'Min price',exact:true});
  const maximum = page.getByRole('slider', {name:'Max price',exact:true});
  await minimum.click({ position: { x: 100, y: 24 } });
  await maximum.click({ position: { x: 20, y: 24 } });
  expect(Number(await maximum.getAttribute('aria-valuenow'))).toBeGreaterThanOrEqual(Number(await minimum.getAttribute('aria-valuenow')));
  await expect(page.getByRole('button', {name:'Show results',exact:true})).toBeEnabled();
  await page.getByRole('button', {name:'Reset',exact:true}).click();
  await expect(page.getByRole('radio', {name:'Relevance',exact:true})).toBeChecked();
  await expect(minimum).toHaveAttribute('aria-valuenow', '0');
  await expect(maximum).toHaveAttribute('aria-valuetext', 'Any price');
  await page.getByRole('radio', {name:'Price: high to low',exact:true}).click();
  await page.getByRole('button', {name:'Done',exact:true}).click();
  await page.getByRole('button', {name:'Filter & sort',exact:true}).click();
  await expect(page.getByRole('radio', {name:'Relevance',exact:true})).toBeChecked();
  await page.getByRole('radio', {name:'Price: high to low',exact:true}).click();
  const action = page.getByRole('button', {name:'Show results',exact:true});
  const bounds = await action.boundingBox();
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844);
  await action.click();
  await page.getByRole('button', {name:'Filter & sort',exact:true}).click();
  await expect(page.getByRole('radio', {name:'Price: high to low',exact:true})).toBeChecked();
});
test('product purchase bar adds then updates cart quantity above navigation', async ({page}, testInfo) => {
  await page.goto('/');
  await page.getByRole('button',{name:'Customer',exact:true}).click();
  await expect(page.getByText('12 Garden Street, Cairo',{exact:true})).toBeVisible();
  await page.getByRole('tab',{name:'Cart',exact:true}).click();
  await page.getByRole('button',{name:'Remove',exact:true}).click();
  await page.getByRole('tab',{name:'Deals',exact:true}).click();
  await page.getByRole('button',{name:'Fresh apples',exact:true}).click();
  await expect(page.getByRole('button',{name:'Select an option above',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'Apples — 1 kg · EGP 25.00',exact:true}).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', {name:'Increase quantity',exact:true})).toHaveCount(0);
  const add=dialog.getByRole('button',{name:'Add to cart',exact:true});
  const bounds=await add.boundingBox();
  const navigation=await dialog.getByRole('tab',{name:'Cart',exact:true}).boundingBox();
  expect(bounds!.y+bounds!.height).toBeLessThanOrEqual(navigation!.y);
  await add.click();
  await expect(add).toHaveCount(0);
  await dialog.getByRole('button',{name:'Decrease quantity',exact:true}).click();
  await expect(add).toBeVisible();
  await add.click();
  await dialog.getByRole('button',{name:'Increase quantity',exact:true}).click();
  await expect(dialog.getByLabel('Quantity',{exact:true})).toHaveText('2');
  await dialog.getByRole('button',{name:'Increase quantity',exact:true}).click();
  await expect(dialog.getByLabel('Quantity',{exact:true})).toHaveText('3');
  await expect(dialog.getByRole('button',{name:'Save to wishlist',exact:true})).toHaveText('');
  await expect(dialog.getByRole('button',{name:'Compare this product',exact:true})).toHaveText('');
  await page.screenshot({path:testInfo.outputPath('product-controls.png')});
  await dialog.getByRole('tab',{name:'Cart',exact:true}).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('3 × EGP 25.00',{exact:true})).toBeVisible();
  await expect(page.getByText('EGP 75.00',{exact:true}).first()).toBeVisible();
});

for (const ar of [false, true]) {
  test(`notification inbox read state and pause (${ar ? 'Arabic' : 'English'})`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://grocery.rocento.com/api/**', route => { errors.push('Unexpected live request'); return route.abort(); });
    await page.goto('/');
    await page.getByRole('button', { name: 'Customer', exact: true }).click();
    await expect(page.getByText('12 Garden Street, Cairo', { exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'Account', exact: true }).click();
    if (ar) {
      await page.getByRole('button', { name: 'Language', exact: true }).click();
      await page.getByRole('button', { name: 'العربية', exact: true }).click();
      await page.getByRole('button', { name: 'حسابي', exact: true }).click();
    }
    await page.getByRole('button', { name: ar ? 'الإشعارات' : 'Notifications', exact: true }).click();
    await expect(page.getByRole('button', { name: ar ? 'غير المقروءة (1)' : 'Unread (1)', exact: true })).toBeVisible();
    await page.getByRole('button', { name: ar ? 'تحديد الكل كمقروء' : 'Mark all read', exact: true }).click();
    await page.getByRole('button', { name: ar ? 'غير المقروءة (0)' : 'Unread (0)', exact: true }).click();
    await expect(page.getByText(ar ? 'قرأت كل التحديثات' : 'You’re all caught up', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: ar ? 'إيقاف تحديثات الطلبات' : 'Pause order updates', exact: true }).click();
    await expect(page.getByText(ar ? 'تحديثات الطلبات متوقفة' : 'Order updates are paused', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: ar ? 'تم' : 'Done', exact: true }).click();
    await page.getByRole('button', { name: ar ? 'الإشعارات' : 'Notifications', exact: true }).click();
    await expect(page.getByText(ar ? 'تحديثات الطلبات متوقفة' : 'Order updates are paused', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: ar ? 'تفعيل تحديثات الطلبات' : 'Enable order updates', exact: true }).click();
    await page.getByRole('button', { name: ar ? 'الكل' : 'All', exact: true }).click();
    await page.getByRole('button', { name: ar ? 'عرض الطلب' : 'View order', exact: true }).click();
    await expect(page.getByRole('button', { name: ar ? 'تحديث الطلب' : 'Refresh order', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test('authentication form clears secrets on mode changes and dismissal', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://grocery.rocento.com/api/**', route => { errors.push('Unexpected live request'); return route.abort(); });
  await page.goto('/');
  await page.getByRole('tab', { name: 'Account', exact: true }).click();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('textbox', { name: 'Email or mobile number', exact: true }).fill('person@example.test');
  await page.getByLabel('Password', { exact: true }).fill('private password');
  await page.getByRole('checkbox', { name: /Show password/ }).click();
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Email or mobile number', exact: true })).toHaveValue('person@example.test');
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
  await expect(page.getByRole('checkbox', { name: /Show password/ })).not.toBeChecked();
  await page.getByLabel('Password', { exact: true }).fill('new private password');
  await page.getByLabel('Confirm password', { exact: true }).fill('new private password');
  await page.getByRole('tab', { name: 'Home', exact: true }).click();
  await page.getByRole('tab', { name: 'Account', exact: true }).click();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
  expect(errors).toEqual([]);
});

for (const ar of [false, true]) {
  test(`order history returns from detail and clears navigation on sign out (${ar ? 'Arabic' : 'English'})`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('https://grocery.rocento.com/api/**', route => { errors.push('Unexpected live network request'); return route.abort(); });
    await page.goto('/'); await page.getByRole('button', { name: 'Customer', exact: true }).click();
    await expect(page.getByText('12 Garden Street, Cairo', { exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'Account', exact: true }).click();
    if (ar) {
      await page.getByRole('button', { name: 'Language', exact: true }).click();
      await page.getByRole('button', { name: 'العربية', exact: true }).click();
      await page.getByRole('button', { name: 'حسابي', exact: true }).click();
    }
    await page.getByRole('button', { name: ar ? 'طلباتي' : 'My orders', exact: true }).click();
    await expect(page.getByText(ar ? 'طلباتك' : 'Your orders', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: ar ? 'تتبّع الطلب' : 'Track order', exact: true }).first().click();
    await expect(page.getByText(ar ? 'تحديثات الطلب' : 'Order updates', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: ar ? 'رجوع' : 'Back', exact: true }).click();
    await expect(page.getByText(ar ? 'طلباتك' : 'Your orders', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: ar ? 'حسابي' : 'My account', exact: true }).click();
    await page.getByRole('button', { name: ar ? 'تسجيل الخروج' : 'Sign out', exact: true }).click();
    await expect(page.getByRole('button', { name: ar ? 'تسجيل الدخول' : 'Sign in', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test('category cart sheet selects options and updates quantities without leaving the grid', async ({ page }, testInfo) => {
  await page.route('https://grocery.rocento.com/api/**', route => route.abort());
  await page.goto('/');
  await page.getByRole('button', { name: 'Empty', exact: true }).click();
  await expect(page.getByText('12 Garden Street, Cairo', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Categories', exact: true }).click();
  await page.getByRole('button', { name: 'Fresh fruit', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Cart', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add to cart: Fresh apples', exact: true }).click();
  await page.getByRole('button', { name: /Apples — 1 kg/ }).click();
  const sheet = page.getByRole('dialog');
  await sheet.getByRole('button', { name: 'Increase quantity', exact: true }).click();
  await expect(sheet.getByLabel('Quantity', { exact: true })).toHaveText('2');
  await sheet.getByRole('button', { name: 'Add to cart', exact: true }).click();
  await expect(sheet.getByText('Added to your bag', { exact: true })).toBeVisible();
  await sheet.getByRole('button', { name: 'Decrease quantity', exact: true }).click();
  await expect(sheet.getByLabel('Quantity', { exact: true })).toHaveText('1');
  await page.screenshot({ path: testInfo.outputPath('category-quick-cart.png') });
  await sheet.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Add to cart: Fresh apples', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Cart', exact: true })).toBeVisible();
});
