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
async function begin(page: Page, two=false) {
  const state=await setup(page);
  await page.route('**/app-preview/catalog?**',route=>{const u=new URL(route.request().url());return route.fulfill({json:{merchantId:u.pathname.split('/')[4],locale:u.searchParams.get('locale'),source:'https://grocery.rocento.com',categories:[],products:[{id:'grapes',name:'Red grapes',price:'2.75',originalPrice:null,currency:'USD',unit:'pack',inStock:true,imageUrl:null},{id:'bread',name:'Bread',price:'1.25',originalPrice:null,currency:'USD',unit:'each',inStock:true,imageUrl:null}]}})});
  await page.reload();await ready(page);const ios=page.getByTestId('preview-iOS');
  for(const name of two?['Red grapes','Bread']:['Red grapes']){
    if(name==='Bread')await ios.getByRole('button',{name:'Home',exact:true}).click();
    await ios.getByRole('button',{name:`View ${name}`,exact:true}).click();
    await ios.getByRole('button',{name:'Add to cart',exact:true}).click();
    await ios.getByRole('button',{name:'View cart',exact:true}).click();
  }
  await accountSection(ios, 'Addresses'); await ios.getByRole('button',{name:'Add delivery address',exact:true}).click();
  await fillPreviewAddress(ios);
  await ios.getByRole('button',{name:'Save address',exact:true}).click();
  await ios.getByText('Checkout preview settings',{exact:true}).click();return {ios,state};
}
async function review(ios:ReturnType<Page['getByTestId']>){
  await ios.getByRole('button',{name:'Check availability',exact:true}).click();
  await ios.getByRole('button',{name:'Review order',exact:true}).click();
}
test('rejected native order preserves data and recovers without writes',async({page})=>{
  const {ios,state}=await begin(page), before=JSON.stringify(state.drafts),writes=state.writes;
  const mutations:string[]=[];page.on('request',r=>{if(!['GET','HEAD','OPTIONS'].includes(r.method()))mutations.push(r.url())});
  await ios.getByLabel('Test scenario',{exact:true}).selectOption('rejected');await review(ios);
  await ios.getByRole('button',{name:'Place order',exact:true}).click();
  await expect(ios.getByRole('alert')).toContainText('could not be confirmed');await expect(ios.getByRole('alert')).toBeFocused();
  await expect(ios.locator('.ms-native-order')).toHaveCount(0);
  await expect(ios.getByLabel('Current quantity')).toHaveText('1');
  await page.getByLabel('Preview language').selectOption('ar');await expect(ios.getByRole('alert')).toContainText('تعذر تأكيد');
  await page.getByLabel('Preview language').selectOption('en');
  await ios.getByRole('button',{name:'Reset scenario',exact:true}).click();await review(ios);
  await ios.getByRole('button',{name:'Place order',exact:true}).click();
  await expect(ios.getByText('Your order is confirmed',{exact:true})).toBeVisible();
  expect(mutations).toEqual([]);expect(JSON.stringify(state.drafts)).toBe(before);expect(state.writes).toBe(writes);
});
test('delivery failures block native checkout and retain the address when recovered',async({page})=>{
  const {ios}=await begin(page);await ios.getByLabel('Test scenario',{exact:true}).selectOption('delivery');
  await ios.getByRole('button',{name:'Check availability',exact:true}).click();
  await expect(ios.getByRole('alert')).toContainText('Delivery is unavailable');
  await expect(ios.getByRole('button',{name:'Review order',exact:true})).toHaveCount(0);
  await ios.getByRole('button',{name:'Check availability',exact:true}).click();
  await expect(ios.getByRole('alert')).toContainText('Delivery is unavailable');
  await ios.getByRole('button',{name:'Reset scenario',exact:true}).click();await review(ios);
  await expect(ios.getByRole('button',{name:/12 Demo Street/})).toHaveAttribute('aria-pressed','true');
  await ios.getByRole('button',{name:'Place order',exact:true}).click();
  await expect(ios.getByText('Your order is confirmed',{exact:true})).toBeVisible();
});
test('stock failures block availability and removed items recalculate native totals',async({page})=>{
  const {ios}=await begin(page,true);await ios.getByLabel('Test scenario',{exact:true}).selectOption('stock');
  await expect(ios.getByRole('button',{name:'Check availability',exact:true})).toBeDisabled();
  await ios.getByRole('button',{name:'Remove one Red grapes',exact:true}).click();
  await expect(ios.locator('.ms-native-bag-line')).toHaveCount(1);
  await expect(ios.locator('.ms-native-subtotal')).toContainText('$1.25');
  await ios.getByRole('button',{name:'Reset scenario',exact:true}).click();await review(ios);
  await expect(ios.locator('.ms-native-quote-total')).toContainText('$6.25');
  await ios.getByRole('button',{name:'Place order',exact:true}).click();
  await expect(ios.getByText('Your order is confirmed',{exact:true})).toBeVisible();
});
test('removing the last unavailable item empties the bag and merchant switch resets scenarios',async({page})=>{
  const {ios}=await begin(page);await ios.getByLabel('Test scenario',{exact:true}).selectOption('stock');
  await ios.getByRole('button',{name:'Remove one Red grapes',exact:true}).click();
  await expect(ios.getByText('Your bag is empty',{exact:true})).toBeVisible();
  await page.getByRole('combobox',{name:'Merchant',exact:true}).selectOption(other);
  await ios.getByText('Checkout preview settings',{exact:true}).click();
  await expect(ios.getByLabel('Test scenario',{exact:true})).toHaveValue('none');
});
test('late delivery failure invalidates quote and cannot bypass a new review',async({page})=>{
  const {ios}=await begin(page);await review(ios);
  await ios.getByLabel('Test scenario',{exact:true}).selectOption('delivery');
  await expect(ios.getByRole('button',{name:'Place order',exact:true})).toHaveCount(0);
  await ios.getByRole('button',{name:'Check availability',exact:true}).click();await expect(ios.getByRole('alert')).toContainText('Delivery is unavailable');
  await ios.getByRole('button',{name:'Reset scenario',exact:true}).click();await review(ios);
  await ios.getByRole('button',{name:'Place order',exact:true}).click();
  await expect(ios.getByText('Your order is confirmed',{exact:true})).toBeVisible();
});

async function accountSection(device: import('@playwright/test').Locator, section: 'Addresses'|'Orders'|'Home') {
  const back = device.getByRole('button', {name:/^(‹ My account|حسابي ›)$/});
  const target = section === 'Home' ? null : device.locator('.ms-account-shortcuts').getByRole('button',{name:new RegExp(section === 'Orders' ? '^(Orders|الطلبات)' : '^(Addresses|العناوين)')});
  if (section === 'Home') { if(await back.isVisible()) await back.click(); return; }
  if (await target!.isVisible()) await target!.click();
}
