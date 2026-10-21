import {fillPreviewAddress} from './address-fixture';
import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import type {
  MobileConfig,
  MobileDraft,
  MobileEnvironment,
  MobileVersion,
} from "../../packages/api-client/src/mobile";
const fixture = JSON.parse(
  readFileSync(
    new URL(
      "../../../commerce-api/rocento-api/crates/domain-mobile/contract/v1/fixtures/merchant-1.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as MobileConfig;
const mid = fixture.tenantId,
  other = "00000000-0000-0000-0000-000000000002";
const actor = "20000000-0000-0000-0000-000000000001";
const config = () => structuredClone(fixture) as MobileConfig;
async function setup(page: Page, role = "owner", signedIn = true) {
  const drafts: Record<MobileEnvironment, MobileDraft> = {
    staging: { revision: 1, config: config() },
    production: { revision: 1, config: config() },
  };
  const versions: Record<MobileEnvironment, MobileVersion[]> = {
    staging: [],
    production: [],
  };
  const state = {
    drafts,
    versions,
    conflict: false,
    validateError: false,
    saveDelay: 0,
    dropPublish: false,
    keys: [] as string[],
    writes: 0,
    apiPaths: [] as string[],
    environments: [] as string[],
  };
  await page.route("**/api/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      path = url.pathname,
      env = (url.searchParams.get("environment") ||
        "staging") as MobileEnvironment;
    state.apiPaths.push(path);
    if (url.searchParams.has("environment")) state.environments.push(url.searchParams.get("environment")!);
    const respond = (data: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(data),
      });
    if (path.endsWith('/app-preview/catalog')) {
      const merchantId = path.split('/')[4];
      const locale = url.searchParams.get('locale') || 'en';
      return respond({ merchantId, locale, source: 'https://grocery.rocento.com',
        categories: [{ id: '7edd7367-5330-47c4-8fa9-73c18f23ea67', slug: 'featured', name: locale === 'ar' ? 'فواكه طازجة' : 'Fresh fruit', imageUrl: null }],
        products: [{ id: '6d1bff50-62ba-40bc-baf2-c9ef685250d1', name: locale === 'ar' ? 'عنب أحمر' : (merchantId === mid ? 'Red grapes' : 'Boutique product'), price: '2.75', originalPrice: null, currency: 'USD', unit: 'pack', inStock: true, imageUrl: null }] });
    }
    if (path === "/api/v1/admin/me")
      return signedIn
        ? respond({
            user: {
              id: actor,
              name: "Mobile Owner",
              email: "owner@mobile.test",
            },
            permissions: ["*"],
          })
        : respond({ error: "Unauthorized" }, 401);
    if (path === "/api/v1/admin/auth/login") {
      signedIn = true;
      return respond({
        user: { id: actor, name: "Mobile Owner", email: "owner@mobile.test" },
        permissions: ["*"],
      });
    }
    if (path === "/api/v1/admin/auth/logout") {
      signedIn = false;
      return respond({ ok: true });
    }
    if (path === "/api/v1/mobile/merchants")
      return respond([
        {
          id: mid,
          name: "Rocento Market",
          role,
          entitlements: {
            wishlist: true,
            locationPicker: true,
            reviews: false,
          },
        },
        {
          id: other,
          name: "Rocento Boutique",
          role: "operator",
          entitlements: {},
        },
      ]);
    if (path.includes(other)) {
      if (path.endsWith("/draft"))
        return respond({
          revision: 1,
          config: {
            ...config(),
            tenantId: other,
            brand: { ...fixture.brand, displayName: "Boutique preview" },
          },
        });
      return respond([]);
    }
    if (path.endsWith("/assets")) {
      if (req.method() === "POST")
        return respond(
          {
            id: "10000000-0000-0000-0000-000000000003",
            name: "New logo",
            kind: "image",
            verified: true,
            url: null,
            width: 16,
            height: 12,
            contentType: "image/png",
            checksum: "b".repeat(64),
            sizeBytes: 100,
          },
          201,
        );
      return respond([
        {
          id: fixture.brand.logoAssetId,
          name: "Market logo",
          kind: "image",
          verified: true,
          url: null,
          width: 16,
          height: 12,
          contentType: "image/png",
          checksum: "a".repeat(64),
          sizeBytes: 100,
        },
      ]);
    }
    if (path.endsWith("/content"))
      return route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><rect width="200" height="120" fill="#2d6349"/><circle cx="100" cy="60" r="32" fill="#e0efba"/></svg>',
      });
    if (path.endsWith("/audit"))
      return respond([
        {
          id: "40000000-0000-0000-0000-000000000001",
          actorId: actor,
          action: "config.draft_saved",
          details: { before: null, after: drafts[env].config },
          createdAt: "2026-10-11T09:00:00Z",
        },
      ]);
    if (path.endsWith("/versions")) return respond(versions[env]);
    if (path.endsWith("/draft")) {
      if (req.method() === "GET") return respond(drafts[env]);
      state.writes++;
      if (state.saveDelay)
        await new Promise((r) => setTimeout(r, state.saveDelay));
      if (
        state.conflict ||
        req.postDataJSON().expectedRevision !== drafts[env].revision
      )
        return respond({ error: "Revision conflict", issues: [] }, 409);
      drafts[env] = {
        revision: drafts[env].revision + 1,
        config: req.postDataJSON().config,
      };
      return respond(drafts[env]);
    }
    if (path.endsWith("/validate"))
      return state.validateError
        ? respond(
            {
              error: "Validation failed",
              issues: [{ path: "/brand/logoAssetId", code: "ASSET_NOT_OWNED" }],
            },
            422,
          )
        : respond({ valid: true });
    if (path.endsWith("/publish") || path.endsWith("/rollback")) {
      const key = req.headers()["idempotency-key"];
      state.keys.push(key);
      if (state.dropPublish) {
        state.dropPublish = false;
        return route.abort("failed");
      }
      if (role !== "owner") return respond({ error: "Forbidden" }, 403);
      const target = req.postDataJSON().targetVersion;
      const body = target
        ? versions[env].find((v) => v.version === target)!.config
        : drafts[env].config;
      const next: MobileVersion = {
        version: (versions[env][0]?.version || 0) + 1,
        config: {
          ...body,
          configVersion: (versions[env][0]?.version || 0) + 1,
        },
        checksum: "c".repeat(64),
        publishedBy: actor,
        publishedAt: "2026-10-11T10:00:00Z",
        rollbackTarget: versions[env][0]?.version || null,
      };
      versions[env].unshift(next);
      drafts[env] = {
        revision: drafts[env].revision + 1,
        config: { ...body, configVersion: 0 },
      };
      return respond(next);
    }
    return respond({ error: `Unexpected API ${path}` }, 404);
  });
  await page.goto("/");
  return state;
}
async function ready(page: Page) {
  await expect(
    page.getByRole("heading", { name: "Your mobile experience" }),
  ).toBeVisible();
  await expect(page.getByLabel("App display name")).toBeVisible();
}
async function saveAddress(ios:ReturnType<Page['getByTestId']>, label:string, city:string){
  await ios.getByRole('region',{name:'Saved addresses',exact:true}).getByRole('button',{name:'Add delivery address',exact:true}).click();
  for(const [field,value] of Object.entries({'Address label':label,'Full name':'Test Shopper','Phone number':'+20 100 000 0000','Street and apartment':'12 Sample Street','City':city,'Country':'Egypt'}))await ios.getByLabel(field,{exact:true}).fill(value);
  await ios.getByRole('button',{name:'Save address',exact:true}).click();
}
test('saved addresses edit, choose defaults, persist and prefill checkout without writes',async({page})=>{
  const state=await setup(page);await ready(page);const ios=page.getByTestId('preview-iOS'),android=page.getByTestId('preview-Android');
  const before=JSON.stringify(state.drafts), writes=state.writes,mutations:string[]=[];page.on('request',r=>{if(!['GET','HEAD','OPTIONS'].includes(r.method()))mutations.push(r.url())});
  await ios.getByRole('button',{name:'Account',exact:true}).click();await accountSection(ios, 'Addresses'); await ios.getByText('Saved preview addresses',{exact:true}).click();await saveAddress(ios,'Home','Cairo');await saveAddress(ios,'Work','Giza');
  await ios.getByRole('article',{name:'Work',exact:true}).getByRole('button',{name:'Set as default'}).click();
  await ios.getByRole('article',{name:'Home',exact:true}).getByRole('button',{name:'Edit address'}).click();await ios.getByLabel('City',{exact:true}).fill('Alexandria');await ios.getByRole('button',{name:'Save address',exact:true}).click();
  await expect(ios.getByRole('article',{name:'Home',exact:true})).toContainText('Alexandria');
  await android.getByRole('button',{name:'Account',exact:true}).click();await accountSection(android, 'Addresses'); await android.getByText('Saved preview addresses',{exact:true}).click();await expect(android.getByText('No saved addresses yet.')).toBeVisible();
  await page.reload();await ready(page);await ios.getByRole('button',{name:'Account',exact:true}).click();await accountSection(ios, 'Addresses'); await ios.getByText('Saved preview addresses',{exact:true}).click();await expect(ios.getByRole('article',{name:'Work',exact:true})).toContainText('Default');
  await ios.getByRole('button',{name:'Home',exact:true}).click();await ios.getByRole('button',{name:'View Red grapes',exact:true}).click();await ios.getByRole('button',{name:'Add to cart',exact:true}).click();await ios.getByRole('button',{name:'View cart',exact:true}).click();await expect(ios.locator('.ms-native-address-choice[aria-pressed="true"]')).toHaveCount(1);
  await ios.getByRole('button',{name:'Complete delivery pin',exact:true}).click();
  await expect(ios.getByLabel('Street and address')).toHaveValue('12 Sample Street');
  await fillPreviewAddress(ios);await ios.getByLabel('Street and address').fill('12 Sample Street');
  await ios.getByRole('button',{name:'Save address',exact:true}).click();
  await expect(ios.getByRole('button',{name:'Complete delivery pin',exact:true})).toHaveCount(0);
  await ios.getByRole('button',{name:'Check availability',exact:true}).click();
  await ios.getByRole('button',{name:'Review order',exact:true}).click();
  await expect(ios.locator('.ms-native-quote')).toBeVisible();
  await ios.getByRole('button',{name:'Account',exact:true}).click();await accountSection(ios, 'Addresses'); await ios.getByText('Saved preview addresses',{exact:true}).click();
  await ios.getByRole('article',{name:'Work',exact:true}).getByRole('button',{name:'Delete address'}).click();await expect(ios.getByRole('article',{name:'Work',exact:true})).toHaveCount(0);
  await expect(ios.getByRole('article',{name:'Home',exact:true})).toContainText('Default');
  expect(JSON.stringify(state.drafts)).toBe(before);expect(state.writes).toBe(writes);expect(mutations).toEqual([]);
});
test('wishlist persists per merchant and device and saved products can be shopped',async({page})=>{
  await setup(page);await ready(page);const ios=page.getByTestId('preview-iOS'),android=page.getByTestId('preview-Android');
  await ios.getByRole('button',{name:'View Red grapes',exact:true}).click();await ios.getByRole('button',{name:'Save to wishlist',exact:true}).click();await expect(ios.getByRole('button',{name:'Remove from wishlist'})).toHaveAttribute('aria-pressed','true');await ios.getByRole('button',{name:'Back',exact:true}).click();
  await ios.getByRole('button',{name:'Account',exact:true}).click();await ios.getByRole('button',{name:/^Wishlist/}).click();await expect(ios.getByRole('article',{name:'Red grapes',exact:true})).toBeVisible();
  await android.getByRole('button',{name:'Account',exact:true}).click();await android.getByRole('button',{name:/^Wishlist/}).click();await expect(android.getByText('Your wishlist is empty.',{exact:false})).toBeVisible();
  await ios.getByRole('button',{name:'View product',exact:true}).click();await ios.getByRole('button',{name:'Add to cart',exact:true}).click();await ios.getByRole('button',{name:'Back',exact:true}).click();await ios.getByRole('button',{name:/^Cart(?: \d+)?$/}).click();await expect(ios.getByLabel('Current quantity')).toHaveText('1');
  await page.reload();await ready(page);await ios.getByRole('button',{name:'Account',exact:true}).click();await ios.getByRole('button',{name:/^Wishlist/}).click();await expect(ios.getByRole('article',{name:'Red grapes',exact:true})).toBeVisible();
  await page.getByRole('combobox',{name:'Merchant',exact:true}).selectOption(other);await ios.getByRole('button',{name:'Account',exact:true}).click();await ios.getByRole('button',{name:/^Wishlist/}).click();await expect(ios.getByText('Your wishlist is empty.',{exact:false})).toBeVisible();
  await page.getByRole('combobox',{name:'Merchant',exact:true}).selectOption(mid);await ios.getByRole('button',{name:'Account',exact:true}).click();await ios.getByRole('button',{name:/^Wishlist/}).click();await expect(ios.getByRole('article',{name:'Red grapes',exact:true})).toBeVisible();
  await ios.getByRole('button',{name:'Remove from wishlist',exact:true}).click();await expect(ios.getByText('Your wishlist is empty.',{exact:false})).toBeVisible();
});
test('address validation and explicit clearing keep saved preview data under user control',async({page})=>{
  await setup(page);await ready(page);const ios=page.getByTestId('preview-iOS');await ios.getByRole('button',{name:'Account',exact:true}).click();await accountSection(ios, 'Addresses'); await ios.getByText('Saved preview addresses',{exact:true}).click();
  await ios.getByRole('region',{name:'Saved addresses',exact:true}).getByRole('button',{name:'Add delivery address',exact:true}).click();await ios.getByRole('button',{name:'Save address',exact:true}).click();await expect(ios.getByLabel('Full name',{exact:true})).toBeVisible();
  await ios.getByRole('button',{name:'Cancel',exact:true}).click();await saveAddress(ios,'Home','Cairo');
  await page.getByLabel('Preview language').selectOption('ar');await ios.locator('.ms-account-shortcuts').getByRole('button',{name:/^العناوين/}).click();await ios.getByText('عناوين المعاينة المحفوظة',{exact:true}).click();await expect(ios.getByRole('heading',{name:'العناوين المحفوظة'})).toBeVisible();
  await page.getByLabel('Preview language').selectOption('en');await accountSection(ios, 'Addresses'); await ios.getByText('Saved preview addresses',{exact:true}).click();await accountSection(ios, 'Home'); await ios.getByRole('button',{name:'Clear saved preview data',exact:true}).click();await accountSection(ios,'Addresses');await ios.getByText('Saved preview addresses',{exact:true}).click();await expect(ios.getByText('No saved addresses yet.')).toBeVisible();
  await page.reload();await ready(page);await ios.getByRole('button',{name:'Account',exact:true}).click();await accountSection(ios, 'Addresses'); await ios.getByText('Saved preview addresses',{exact:true}).click();await expect(ios.getByText('No saved addresses yet.')).toBeVisible();
});

test('preview keeps native viewport geometry when the editor is narrow', async ({page}) => {
  await setup(page); await ready(page);
  const ios=page.getByTestId('preview-iOS').locator('.ms-phone');
  const android=page.getByTestId('preview-Android').locator('.ms-phone');
  await expect(ios).toHaveAttribute('data-screen-width','402');
  await expect(android).toHaveAttribute('data-screen-width','412');
  expect(await ios.evaluate(e=>e.clientWidth)).toBe(402);
  expect(await android.evaluate(e=>e.clientWidth)).toBe(412);
  expect(await page.getByTestId('preview-iOS').locator('.ms-native-app > nav').evaluate(e=>e.clientWidth)).toBe(402);
  await page.getByRole('combobox',{name:'Device width',exact:true}).selectOption('390');
  expect(await ios.evaluate(e=>e.clientWidth)).toBe(390);
  await page.setViewportSize({width:390,height:900});
  await expect.poll(()=>ios.evaluate(e=>Number(getComputedStyle(e).zoom))).toBeLessThan(1);
  expect(await ios.evaluate(e=>e.clientWidth)).toBe(390);
  expect(await ios.evaluate(e=>e.getBoundingClientRect().width)).toBeLessThan(390);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

async function accountSection(device: import('@playwright/test').Locator, section: 'Addresses'|'Orders'|'Home') {
  const back = device.getByRole('button', {name:/^(‹ My account|حسابي ›)$/});
  const target = section === 'Home' ? null : device.locator('.ms-account-shortcuts').getByRole('button',{name:new RegExp(section === 'Orders' ? '^(Orders|الطلبات)' : '^(Addresses|العناوين)')});
  if (section === 'Home') { if(await back.isVisible()) await back.click(); return; }
  if (await target!.isVisible()) await target!.click();
}
