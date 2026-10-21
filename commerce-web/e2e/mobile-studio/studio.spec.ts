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
  const mediaItems = [{ id: fixture.brand.logoAssetId, name: 'Market logo', kind: 'image', verified: true, url: null, width: 16, height: 12, contentType: 'image/png', checksum: 'a'.repeat(64), sizeBytes: 100, folderId: null as string | null }];
  let mediaFolders: { id: string; name: string; parentId: string | null; assetCount: number }[] = [];
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
    if (path.endsWith('/asset-folders')) {
      if (req.method() === 'POST') {
        const body = req.postDataJSON(); const folder = { id: `folder-${mediaFolders.length + 1}`, ...body, assetCount: 0 };
        mediaFolders.push(folder); return respond(folder, 201);
      }
      return respond(mediaFolders.map(f => ({ ...f, assetCount: mediaItems.filter(a => a.folderId === f.id).length })));
    }
    if (path.includes('/asset-folders/')) {
      const id = path.split('/').at(-1)!;
      if (req.method() === 'DELETE') {
        const removed = new Set([id]); let size = 0;
        while (size !== removed.size) { size = removed.size; mediaFolders.filter(f => f.parentId && removed.has(f.parentId)).forEach(f => removed.add(f.id)); }
        mediaFolders = mediaFolders.filter(f => !removed.has(f.id)); mediaItems.forEach(a => { if (a.folderId && removed.has(a.folderId)) a.folderId = null; });
        return respond({ ok: true });
      }
      const folder = mediaFolders.find(f => f.id === id)!; Object.assign(folder, req.postDataJSON()); return respond(folder);
    }
    if (path.endsWith('/assets/move')) {
      const body = req.postDataJSON(); mediaItems.forEach(a => { if (body.ids.includes(a.id)) a.folderId = body.folderId; }); return respond({ ok: true });
    }
    if (/\/assets\/[^/]+$/.test(path) && req.method() === 'PUT') { const asset = mediaItems.find(a => a.id === path.split('/').at(-1))!; Object.assign(asset, req.postDataJSON()); return respond({ ok: true }); }
    if (path.endsWith('/asset-library')) {
      const folder = url.searchParams.get('folder') || 'all', q = url.searchParams.get('q') || '';
      const items = mediaItems.filter(a => (folder === 'all' || (folder === 'unfiled' ? !a.folderId : a.folderId === folder)) && a.name.toLowerCase().includes(q.toLowerCase()));
      const offset = Number(url.searchParams.get('offset') || 0); return respond({ items: items.slice(offset, offset + 48), total: items.length });
    }
    if (path.endsWith('/assets')) {
      if (req.method() === 'POST') {
        const asset = { ...mediaItems[0], id: '10000000-0000-0000-0000-000000000003', name: 'New logo' }; mediaItems.unshift(asset); return respond(asset, 201);
      }
      return respond(mediaItems);
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
async function publish(page: Page, env = "production") {
  await page
    .getByRole("button", { name: "Validate draft", exact: true })
    .click();
  await page.getByRole("button", { name: "Review & publish" }).click();
  await page.getByRole("dialog").getByRole("checkbox").check();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: `Publish to ${env}`, exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Validate draft", exact: true }),
  ).toBeEnabled();
}
test("separate login, design, Arabic previews and direct production publish", async ({
  page,
}) => {
  const state = await setup(page, "owner", false);
  const policy = (await page.request.get("/")).headers()["content-security-policy"];
  expect(policy).toContain("script-src 'self';");
  expect(policy).not.toContain("unsafe-eval");
  await expect(
    page.getByRole("heading", { name: "Sign in to App Studio" }),
  ).toBeVisible();
  await page.getByLabel("Work email").fill("owner@mobile.test");
  await page.getByLabel("Password", { exact: true }).fill("test-only-password");
  await page.getByRole("button", { name: "Sign in to App Studio" }).click();
  await ready(page);
  await expect(page.getByText("Catalog enrichment")).toHaveCount(0);
  await page.getByLabel("Brand color (primary hex)", { exact: true }).fill("#B45134");
  await page.getByRole("button", { name: "Sections", exact: true }).click();
  const first = state.drafts.production.config.screens.home.sections[0].id;
  await page
    .getByRole("button", { name: `Move ${first} down`, exact: true })
    .click();
  await page.getByLabel("Add section").selectOption("richText");
  await expect.poll(() => state.drafts.production.revision).toBe(2);
  await page.getByLabel("Preview language").selectOption("ar");
  await expect(page.getByLabel("Preview appearance")).toHaveCount(0);
  await expect(page.getByTestId("preview-iOS")).toHaveAttribute("dir", "rtl");
  await expect(page.getByTestId("preview-Android")).toHaveAttribute(
    "dir",
    "rtl",
  );
  await publish(page);
  expect(state.versions.production[0].config.brand.light.primary).toBe("#B45134");
  expect(state.versions.production[0].config.screens.home.sections[1].id).toBe(
    first,
  );
  await expect(page.getByRole("combobox", { name: "Environment", exact: true })).toHaveCount(0);
  await expect(page.getByText("Use latest staging release")).toHaveCount(0);
  expect(state.environments.every((value) => value === "production")).toBe(true);
  expect(state.versions.staging).toHaveLength(0);
  await expect(
    page.getByText(
      "Version 1 published to production. No store build required.",
    ),
  ).toBeVisible();
  expect(state.versions.production[0].config.brand.light.primary).toBe(
    "#B45134",
  );
  expect(
    state.apiPaths.every(
      (p) =>
        p.startsWith("/api/v1/merchants/") ||
        [
          "/api/v1/admin/me",
          "/api/v1/admin/auth/login",
          "/api/v1/mobile/merchants",
        ].includes(p),
    ),
  ).toBe(true);
});
test("designer edits and validates but cannot approve; operator sees only their selected workspace", async ({
  page,
}) => {
  await setup(page, "designer");
  await ready(page);
  await page.getByLabel("App display name").fill("Designer edition");
  await expect(page.getByText(/Draft r2 · Saved/)).toBeVisible();
  await page
    .getByRole("button", { name: "Validate draft", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Review & publish" }),
  ).toBeDisabled();
  await expect(page.getByRole("button", { name: "✓ Validated", exact: true })).toBeEnabled();
  await page
    .getByRole("combobox", { name: "Merchant", exact: true })
    .selectOption(other);
  await expect(page.getByLabel("App display name")).toHaveValue(
    "Boutique preview",
  );
  await expect(page.getByLabel("App display name")).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Validate draft", exact: true }),
  ).toBeDisabled();
  await expect(page.getByText("Designer edition", { exact: true })).toHaveCount(
    0,
  );
});
test("contrast and asset validation block publication; conflicts preserve unsaved edits", async ({
  page,
}) => {
  const state = await setup(page);
  await ready(page);
  await page
    .getByLabel("On-brand text (onPrimary hex)")
    .fill(fixture.brand.light.primary);
  await expect(page.getByText(/INSUFFICIENT CONTRAST/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save draft", exact: true }),
  ).toBeDisabled();
  expect(state.writes).toBe(0);
  await page
    .getByLabel("On-brand text (onPrimary hex)")
    .fill(fixture.brand.light.onPrimary);
  state.validateError = true;
  await page
    .getByRole("button", { name: "Validate draft", exact: true })
    .click();
  await expect(page.getByText(/ASSET NOT OWNED/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Review & publish" }),
  ).toBeDisabled();
  state.conflict = true;
  await page.getByLabel("App display name").fill("Keep these local changes");
  await expect(
    page.getByText(
      "The saved revision changed. Your local edits are preserved.",
    ),
  ).toBeVisible();
  await expect(page.getByLabel("App display name")).toHaveValue(
    "Keep these local changes",
  );
  state.conflict = false;
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Load latest draft" }).click();
  await expect(page.getByLabel("App display name")).toHaveValue(
    fixture.brand.displayName,
  );
});
test("edits made during autosave are saved in the next revision", async ({
  page,
}) => {
  const state = await setup(page);
  await ready(page);
  state.saveDelay = 1100;
  await page.getByLabel("App display name").fill("First edit");
  await expect(page.getByText("Saving…", { exact: true })).toBeVisible();
  await page.getByLabel("App display name").fill("Latest edit");
  await expect.poll(() => state.drafts.production.revision).toBe(3);
  expect(state.drafts.production.config.brand.displayName).toBe("Latest edit");
  await expect(page.getByLabel("App display name")).toHaveValue("Latest edit");
});
test("retry preserves idempotency key and rollback creates another immutable release", async ({
  page,
}) => {
  const state = await setup(page);
  await ready(page);
  await publish(page);
  await page.getByLabel("App display name").fill("Second release");
  await expect(page.getByText(/Draft r3 · Saved/)).toBeVisible();
  state.dropPublish = true;
  await page
    .getByRole("button", { name: "Validate draft", exact: true })
    .click();
  await page.getByRole("button", { name: "Review & publish" }).click();
  await page.getByRole("dialog").getByRole("checkbox").check();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Publish to production", exact: true })
    .click();
  await expect(page.getByRole("dialog").getByRole("alert")).toBeVisible();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Publish to production", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(state.keys[1]).toBe(state.keys[2]);
  await page
    .getByRole("button", { name: "Release history", exact: true })
    .click();
  await page.getByRole("button", { name: "Review rollback to v1" }).click();
  await page.getByRole("dialog").getByRole("checkbox").check();
  await page
    .getByRole("button", { name: "Confirm rollback", exact: true })
    .click();
  await expect(
    page.getByText(
      "Version 3 published to production by restoring version 1. No store build required.",
    ),
  ).toBeVisible();
  expect(state.versions.production[0].config.brand.displayName).toBe(
    fixture.brand.displayName,
  );
  await expect(page.getByText("Previous live version: v2", { exact: true })).toBeVisible();
});
test("upload selects a merchant-owned logo and the standalone page fits narrow screens", async ({
  page,
}) => {
  await setup(page);
  await ready(page);
  await page.getByRole("button", { name: "Assets", exact: true }).click();
  await page.getByRole("button", { name: "Upload images", exact: true }).click();
  await page
    .getByLabel("Image files")
    .setInputFiles({
      name: "logo.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "test fixture; image sanitization is covered by the real API tests",
      ),
    });
  await page.getByLabel("Name for logo.png").fill("New logo");
  await page.getByRole("button", { name: "Upload 1 image", exact: true }).click();
  await expect(
    page.getByText("New logo uploaded. Select it as a logo or banner."),
  ).toBeVisible();
  await page
    .getByRole("article")
    .filter({ hasText: "New logo" })
    .getByRole("button", { name: "Use as logo" })
    .click();
  await expect(page.getByText(/Draft r2 · Saved/)).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
  await page.getByRole("button", { name: "Brand & theme", exact: true }).click();
  await expect(page.getByLabel("In-app logo").locator("option:checked")).toHaveText("New logo");
  await page.screenshot({
    path: "test-results/mobile-studio/mobile-390.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page
    .getByRole("button", { name: "Brand & theme", exact: true })
    .click();
  await page.screenshot({
    path: "test-results/mobile-studio/desktop-1440.png",
    fullPage: true,
  });
});

test("owner connects and revokes an internal installation without exposing runtime APIs", async ({page}) => {
  await setup(page);
  let revoked=false;
  const device="30000000-0000-0000-0000-000000000001";
  await page.route("**/api/v1/merchants/*/app-devices**", async route => {
    const path=new URL(route.request().url()).pathname;
    let data: unknown=[];
    if(path.endsWith("/identities"))data=[{id:actor,platform:"ios",identifier:"com.rocento.grocery"}];
    else if(path.endsWith("/invitations")) {
      expect(route.request().postDataJSON()).toEqual({identityId:actor});
      data={code:"c".repeat(64),expiresIn:900};
    } else if(path.endsWith("/revoke")){revoked=true;data={revoked:true};}
    else data=[{id:device,platform:"ios",identifier:"com.rocento.grocery",createdAt:"2026-10-11T00:00:00Z",expiresAt:"2026-11-10T00:00:00Z",revokedAt:revoked?"2026-10-11T00:01:00Z":null}];
    await route.fulfill({json:data});
  });
  await ready(page);
  await page.getByRole("button",{name:"Test installations",exact:true}).click();
  await page.getByRole("button",{name:"Create iOS connection code"}).click();
  await expect(page.getByLabel("One-time connection code",{exact:true})).toHaveValue("c".repeat(64));
  await page.getByRole("button",{name:"Hide code"}).click();
  await expect(page.getByLabel("One-time connection code",{exact:true})).toHaveCount(0);
  await page.getByRole("button",{name:"Revoke installation",exact:true}).click();
  await expect(page.getByText("Revoked",{exact:true})).toBeVisible();
  await page.screenshot({path:"test-results/mobile-studio/enrollment.png",fullPage:true});
});

test("designers cannot issue internal installation codes",async({page})=>{
  const state=await setup(page,"designer");await ready(page);
  await page.getByRole("button",{name:"Test installations",exact:true}).click();
  await expect(page.getByText("Only the merchant owner can connect or revoke internal test installations.")).toBeVisible();
  expect(state.apiPaths.some(path=>path.includes("app-devices"))).toBe(false);
});

test("component library composes native layouts with independent bilingual section content", async ({ page }) => {
  const state = await setup(page);
  await ready(page);
  await page.getByRole('button', { name: 'Sections', exact: true }).click();
  const originalCount = state.drafts.production.config.screens.home.sections.length;
  await page.getByRole('button', { name: 'Component library', exact: true }).click();
  await page.getByLabel('Search components').fill('carousel');
  await expect(page.getByRole('button', { name: 'Add Product carousel', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add Hero banner', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Add Store discovery', exact: true }).click();
  await page.getByLabel('English content', { exact: true }).fill('Our flagship collection');
  await page.getByLabel('Arabic content', { exact: true }).fill('مجموعتنا المميزة');
  await expect.poll(() => state.drafts.production.config.screens.home.sections.length).toBe(originalCount + 3);
  await page.getByRole('button', { name: 'Duplicate section', exact: true }).click();
  await page.getByLabel('English content', { exact: true }).fill('Independent campaign');
  await expect.poll(() => state.drafts.production.config.screens.home.sections.length).toBe(originalCount + 4);
  const saved = state.drafts.production.config;
  const original = saved.screens.home.sections[originalCount];
  const duplicate = saved.screens.home.sections[originalCount + 1];
  expect(original.type).toBe('richText');
  expect(duplicate.type).toBe('richText');
  if (original.type === 'richText' && duplicate.type === 'richText') {
    expect(saved.localization.messages.en![original.props.textKey]).toBe('Our flagship collection');
    expect(saved.localization.messages.en![duplicate.props.textKey]).toBe('Independent campaign');
    expect(saved.localization.messages.ar![duplicate.props.textKey]).toBe('مجموعتنا المميزة');
  }
  await expect(page.locator('.ms-section-list > li.is-active')).toHaveCount(1);
  await expect(page.locator('.ms-preview-area')).toBeHidden();
  await page.getByRole('button', { name: 'Remove section', exact: true }).click();
  await page.getByRole('button', { name: 'Keep section', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Confirm section removal' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Remove section', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm removal', exact: true }).click();
  await expect.poll(() => state.drafts.production.config.screens.home.sections.length).toBe(originalCount + 3);
  await page.screenshot({ path: 'test-results/mobile-studio/advanced-sections-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Component library', exact: true }).click();
  await page.getByLabel('Search components').fill('');
  await page.screenshot({ path: 'test-results/mobile-studio/component-library-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/mobile-studio/component-library-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Close library', exact: true }).click();
  await publish(page);
  expect(state.versions.production[0].config.screens.home.sections).toHaveLength(originalCount + 3);
});

test('operators can inspect components but cannot compose or edit sections', async ({ page }) => {
  await setup(page, 'operator'); await ready(page);
  await page.getByRole('button', { name: 'Sections', exact: true }).click();
  await expect(page.getByLabel('English content', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Duplicate section', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Component library', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Add Hero banner', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Add Store discovery', exact: true })).toBeDisabled();
});

const categoryChoices = [
  { id: 'cat-food', parentId: null, slug: 'food', name: 'Food' },
  { id: 'cat-fruit', parentId: 'cat-food', slug: 'fruit', name: 'Fruit' },
  { id: 'cat-apple', parentId: 'cat-fruit', slug: 'apples', name: 'Apples' },
  { id: 'cat-bread', parentId: 'cat-food', slug: 'bread', name: 'Bread' },
];
test('category picker searches hierarchy and saves product and category selections', async ({ page }) => {
  const state = await setup(page);
  await page.route('**/app-preview/categories', route => route.fulfill({ json: categoryChoices }));
  await ready(page); await page.getByRole('button', { name: 'Sections', exact: true }).click();
  await page.getByLabel('Add section').selectOption('productGrid');
  const picker = page.getByRole('group', { name: 'Product category', exact: true });
  await picker.getByLabel('Search categories').fill('Apples');
  await expect(picker.locator('summary').filter({ hasText: 'Food' })).toBeVisible();
  await expect(picker.locator('summary').filter({ hasText: 'Fruit' })).toBeVisible();
  await picker.getByRole('radio', { name: 'Apples', exact: true }).check();
  await expect(picker.getByText('Food / Fruit / Apples', { exact: true })).toBeVisible();
  await expect.poll(() => state.drafts.production.config.screens.home.sections.at(-1)?.props).toMatchObject({ collectionId: 'cat-apple' });
  await expect(page.getByLabel('Collection ID', { exact: true })).toHaveCount(0);
  await page.getByLabel('Add section').selectOption('categoryGrid');
  const grid = page.getByRole('group', { name: 'Displayed categories' });
  await grid.getByLabel('Search categories').fill('Fruit');
  await grid.getByRole('checkbox', { name: 'Fruit', exact: true }).check();
  await grid.getByRole('checkbox', { name: 'Apples', exact: true }).check();
  while (await grid.getByRole('button', { name: 'Remove unavailable category' }).count()) await grid.getByRole('button', { name: 'Remove unavailable category' }).first().click();
  await expect.poll(() => state.drafts.production.config.screens.home.sections.at(-1)?.props).toMatchObject({ categoryIds: ['cat-fruit', 'cat-apple'] });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await grid.scrollIntoViewIfNeeded();
  await grid.screenshot({ path: 'test-results/mobile-studio/category-picker-mobile.png' });
});
test('category picker retains selection on failure and supports retry and keyboard choice', async ({ page }) => {
  const state = await setup(page); let failed = true;
  await page.route('**/app-preview/categories', route => route.fulfill(failed ? { status: 503, json: { error: 'Unavailable' } } : { json: categoryChoices }));
  await ready(page); await page.getByRole('button', { name: 'Sections', exact: true }).click();
  await page.getByLabel('Add section').selectOption('productCarousel');
  const picker = page.getByRole('group', { name: 'Product category', exact: true });
  await expect(picker.getByRole('alert')).toContainText('Could not load categories');
  await expect.poll(() => state.drafts.production.config.screens.home.sections.at(-1)?.props).toMatchObject({ collectionId: 'featured' });
  failed = false; await picker.getByRole('button', { name: 'Retry categories' }).click();
  await picker.getByLabel('Search categories').fill('no such category');
  await expect(picker.getByText('No matching categories.')).toBeVisible();
  await picker.getByLabel('Search categories').fill('Bread');
  await picker.getByRole('radio', { name: 'Bread', exact: true }).focus(); await page.keyboard.press('Space');
  await expect.poll(() => state.drafts.production.config.screens.home.sections.at(-1)?.props).toMatchObject({ collectionId: 'cat-bread' });
});


test('live preview displays scoped products and categories and refreshes locale', async ({ page }) => {
  await setup(page); await ready(page);
  const ios = page.getByTestId('preview-iOS');
  await expect(ios.getByText('Red grapes', { exact: true })).toBeVisible();
  await expect(ios.getByText('2.75 USD', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Sample product', { exact: false })).toHaveCount(0);
  await page.getByLabel('Preview language').selectOption('ar');
  await expect(ios.getByText('عنب أحمر', { exact: true })).toBeVisible();
  await page.getByRole('navigation', { name: 'iOS preview tabs' }).getByRole('button', { name: 'الأقسام' }).click();
  await expect(ios.getByText('فواكه طازجة', { exact: true }).first()).toBeVisible();
  await page.screenshot({ path: 'test-results/mobile-studio/live-catalog-preview.png', fullPage: true });
});

test('catalog errors never substitute sample products', async ({ page }) => {
  await setup(page);
  await page.route('**/app-preview/catalog?**', route => route.fulfill({status: 422, contentType:'application/json', body:JSON.stringify({error:'Not connected', issues:[{path:'/merchant',code:'CATALOG_NOT_CONNECTED'}]})}));
  await ready(page);
  await expect(page.getByText('This merchant has no catalog connection.').first()).toBeVisible();
  await expect(page.getByText('Sample product', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('button', {name:'Refresh catalog'})).toBeEnabled();
});

test('category picker supports banner destinations and respects read-only roles', async ({ page }) => {
  const state = await setup(page);
  await page.route('**/app-preview/categories', route => route.fulfill({ json: categoryChoices }));
  await ready(page); await page.getByRole('button', { name: 'Sections', exact: true }).click();
  await page.getByLabel('Banner action').selectOption('openCategory');
  const picker = page.getByRole('group', { name: 'Destination category' });
  await picker.getByLabel('Search categories').fill('Apples');
  await picker.getByRole('radio', { name: 'Apples', exact: true }).check();
  await expect.poll(() => state.drafts.production.config.screens.home.sections[0].props).toMatchObject({ action: { type: 'openCategory', categoryId: 'cat-apple' } });
});

test('category picker disables changes for operators', async ({ page }) => {
  await setup(page, 'operator');
  await page.route('**/app-preview/categories', route => route.fulfill({ json: categoryChoices }));
  await ready(page); await page.getByRole('button', { name: 'Sections', exact: true }).click();
  await page.locator('.ms-section-list').getByRole('button', { name: /Product carousel/ }).click();
  const picker = page.getByRole('group', { name: 'Product category', exact: true });
  await expect(picker.getByLabel('Search categories')).toBeDisabled();
  await picker.locator('summary').filter({ hasText: 'Food' }).click();
  await expect(picker.getByRole('radio', { name: 'Bread', exact: true })).toBeDisabled();
});

test('switching merchants discards delayed catalog responses', async ({ page }) => {
  await setup(page);
  await page.route('**/app-preview/catalog?**', async route => {
    const requestUrl = new URL(route.request().url()), merchantId = requestUrl.pathname.split('/')[4];
    if (merchantId === mid) await new Promise(resolve => setTimeout(resolve, 600));
    await route.fulfill({ json: { merchantId, locale:'en', source:'https://grocery.rocento.com', categories:[], products:[{id:merchantId,name:merchantId === mid ? 'Old merchant product' : 'Selected merchant product',price:'9.00',originalPrice:null,currency:'USD',unit:'each',inStock:true,imageUrl:null}] } }).catch(() => {});
  });
  await ready(page);
  await page.getByRole('combobox', {name:'Merchant',exact:true}).selectOption(other);
  await expect(page.getByTestId('preview-iOS').getByText('Selected merchant product', {exact:true})).toBeVisible();
  await page.waitForTimeout(800);
  await expect(page.getByText('Old merchant product',{exact:true})).toHaveCount(0);
});

test('preview browses categories and product details without editing drafts', async ({ page }) => {
  const state = await setup(page); await ready(page);
  const ios = page.getByTestId('preview-iOS');
  const before = JSON.stringify(state.drafts); const writes = state.writes;
  await ios.getByRole('button', { name: 'View Red grapes', exact: true }).click();
  await expect(ios.getByRole('article', { name: 'Product details' })).toBeVisible();
  await expect(ios.getByRole('heading', { name: 'Red grapes' })).toBeVisible();
  await expect(ios.getByText('Available', { exact: true })).toBeVisible();
  await ios.getByRole('button', { name: 'Back', exact: true }).click();
  await ios.getByRole('button', { name: 'Categories', exact: true }).click();
  const request = page.waitForRequest(r => r.url().includes('collection=7edd7367-5330-47c4-8fa9-73c18f23ea67'));
  await ios.getByRole('button', { name: 'Fresh fruit', exact: true }).click(); await request;
  await expect(ios.getByRole('heading', { name: 'Fresh fruit' })).toBeVisible();
  await ios.getByRole('button', { name: 'View Red grapes' }).click();
  await ios.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(ios.getByRole('heading', { name: 'Fresh fruit' })).toBeVisible();
  await ios.getByRole('button', { name: 'Back' }).click();
  await expect(ios.getByRole('button', { name: 'Fresh fruit' })).toBeVisible();
  expect(JSON.stringify(state.drafts)).toBe(before); expect(state.writes).toBe(writes);
  await ios.getByRole('button', { name: 'Fresh fruit' }).click();
  await ios.getByRole('button', { name: 'View Red grapes' }).click();
  await page.getByLabel('Preview language').selectOption('ar');
  await expect(ios.getByRole('article')).toHaveCount(0);
  await ios.getByRole('button', { name: 'فواكه طازجة' }).click();
  await ios.getByRole('button', { name: 'عرض عنب أحمر' }).click();
  await expect(ios.getByRole('heading', { name: 'عنب أحمر' })).toBeVisible();
  await page.getByRole('combobox', { name: 'Merchant', exact: true }).selectOption(other);
  await expect(ios.getByRole('article')).toHaveCount(0);
});

test('category browsing shows empty and retry states', async ({ page }) => {
  await setup(page); let failed = true;
  await page.route('**/app-preview/catalog?*collection=7edd7367-5330-47c4-8fa9-73c18f23ea67*', route => route.fulfill(failed ? { status: 503, json: { error: 'Unavailable' } } : { json: {merchantId: mid, locale:'en', source:'https://grocery.rocento.com',categories:[],products:[]} }));
  await ready(page); const ios = page.getByTestId('preview-iOS');
  await ios.getByRole('button', { name: 'Categories', exact: true }).click();
  await ios.getByRole('button', { name: 'Fresh fruit' }).click();
  await expect(ios.getByRole('alert')).toContainText('could not be loaded');
  failed = false; await ios.getByRole('button', { name: 'Retry search', exact: true }).click();
  await expect(ios.getByText('No products match. Try resetting the filters.')).toBeVisible();
  await ios.getByRole('button', { name: 'Back' }).click();
  await expect(ios.getByRole('button', { name: 'Fresh fruit' })).toBeVisible();
});

test('preview cart merges items, calculates totals and keeps shopping separate from drafts', async ({ page }) => {
  const state = await setup(page); await ready(page); const ios = page.getByTestId('preview-iOS');
  const before = JSON.stringify(state.drafts), writes = state.writes;
  await ios.getByRole('button', {name:'View Red grapes',exact:true}).click();
  await ios.getByRole('button', {name:'Add to cart',exact:true}).click();
  await ios.getByRole('button', {name:'Add to cart',exact:true}).click();
  await expect(ios.locator('.ms-added-to-cart')).toContainText('In cart: 2');
  await ios.getByRole('button', {name:'View cart',exact:true}).click();
  await expect(ios.getByLabel('Current quantity')).toHaveText('2');
  await expect(ios.locator('.ms-native-subtotal')).toContainText('$5.50');
  await ios.getByRole('button', {name:'Add one Red grapes'}).click();
  await expect(ios.locator('.ms-native-subtotal')).toContainText('$8.25');
  await ios.getByRole('button', {name:'Remove one Red grapes'}).click();
  await expect(ios.locator('.ms-native-subtotal')).toContainText('$5.50');
  await expect(page.getByTestId('preview-Android').getByRole('button', {name:'Home',exact:true})).toHaveAttribute('aria-current','page');
  await page.getByTestId('preview-Android').getByRole('button', {name:'Cart',exact:true}).click();
  await expect(page.getByTestId('preview-Android').getByText('Your bag is empty')).toBeVisible();
  await page.getByLabel('Preview language').selectOption('ar');
  await expect(ios.getByLabel('الكمية الحالية')).toHaveText('2');
  await page.getByLabel('Preview language').selectOption('en');
  await ios.getByRole('button', {name:'Remove one Red grapes',exact:true}).click();
  await ios.getByRole('button', {name:'Remove one Red grapes',exact:true}).click();
  await expect(ios.getByText('Your bag is empty')).toBeVisible();
  await ios.getByRole('button', {name:'Home',exact:true}).click();
  await ios.getByRole('button', {name:'View Red grapes',exact:true}).click();
  await ios.getByRole('button', {name:'Add to cart',exact:true}).click();
  await page.getByRole('combobox', {name:'Merchant',exact:true}).selectOption(other);
  await ios.getByRole('button', {name:'Cart',exact:true}).click();
  await expect(ios.getByText('Your bag is empty')).toBeVisible();
  expect(JSON.stringify(state.drafts)).toBe(before); expect(state.writes).toBe(writes);
  expect(state.apiPaths.some(path => /checkout|orders|\/cart/.test(path))).toBe(false);
});

test('preview prevents adding unavailable products', async ({ page }) => {
  await setup(page);
  await page.route('**/app-preview/catalog?**', route => route.fulfill({json:{merchantId:mid,locale:'en',source:'https://grocery.rocento.com',categories:[],products:[{id:'sold-out',name:'Unavailable grapes',price:'2.75',originalPrice:null,currency:'USD',unit:'pack',inStock:false,imageUrl:null}]}}));
  await ready(page); const ios=page.getByTestId('preview-iOS');
  await ios.getByRole('button',{name:'View Unavailable grapes'}).click();
  await expect(ios.getByRole('button',{name:'Out of stock'})).toBeDisabled();
});

async function openOrderPreviewTools(d: ReturnType<Page['getByTestId']>) {
  await accountSection(d, 'Orders');
  const tools=d.locator('.ms-order-preview-tools');
  if(await tools.getAttribute('open')===null) await tools.locator('summary').click();
}
async function orderPreviewAction(d: ReturnType<Page['getByTestId']>,name:string) {
  await openOrderPreviewTools(d);await d.getByRole('button',{name,exact:true}).click();
}
async function openNativeBag(page: Page, platform = 'iOS') {
  const device = page.getByTestId(`preview-${platform}`);
  await device.getByRole('button',{name:'View Red grapes',exact:true}).click();
  await device.getByRole('button',{name:'Add to cart',exact:true}).click();
  await device.getByRole('button',{name:'View cart',exact:true}).click();
  return device;
}
async function saveNativeAddress(device: ReturnType<Page['getByTestId']>) {
  await accountSection(device, 'Addresses'); await device.getByRole('button',{name:'Add delivery address',exact:true}).click();
  await fillPreviewAddress(device);
  await device.getByRole('button',{name:'Save address',exact:true}).click();
}
for (const platform of ['iOS','Android']) {
  test(`native ${platform} delivery, quote, confirmation and account history stay simulated`, async ({page}) => {
    const state=await setup(page); await ready(page);
    const before=JSON.stringify(state.drafts),writes=state.writes, mutations:string[]=[];
    page.on('request',r=>{if(!['GET','HEAD','OPTIONS'].includes(r.method())) mutations.push(r.url());});
    const device=await openNativeBag(page,platform);
    await device.locator('.ms-phone').screenshot({path:`../output/mobile-cart-polish-20261012/cart-${platform}.png`});
    await device.getByRole('button',{name:'Check availability',exact:true}).click();
    await expect(device.getByRole('alert')).toContainText('Choose a delivery address');
    await saveNativeAddress(device);
    await device.getByRole('button',{name:'Check availability',exact:true}).click();
    await device.getByRole('button',{name:'Review order',exact:true}).click();
    await expect(device.locator('.ms-native-quote-total')).toContainText('$7.75');
    await expect(device.getByText('Cash on delivery', {exact:true})).toBeVisible();
    await device.locator('.ms-native-quote').screenshot({path:`../output/mobile-cart-polish-20261012/review-${platform}.png`});
    const size=await device.locator('.ms-phone').evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth}));
    expect(size.scroll).toBeLessThanOrEqual(size.width);
    await page.getByLabel('Preview language').selectOption('ar');
    await expect(device.getByRole('button',{name:'تأكيد الطلب',exact:true})).toBeVisible();
    await page.getByLabel('Preview language').selectOption('en');
    await device.getByRole('button',{name:'Place order',exact:true}).click();
    await expect(device.getByText('Your order is confirmed',{exact:true})).toBeVisible();
    await expect(device.getByText('Your bag is empty',{exact:true})).toBeVisible();
    await device.getByRole('button',{name:'Account',exact:true}).click();
    await expect(device.getByText('No orders yet',{exact:true})).toHaveCount(0);
    await accountSection(device, 'Orders'); await expect(device.locator('.ms-native-order-link')).toHaveCount(1);
    await orderPreviewAction(device,'Simulate next status');
    await expect(device.locator('.ms-native-order-status')).toHaveText('Confirmed');
    await page.screenshot({path:`test-results/mobile-studio/native-${platform}-order.png`,fullPage:true});
    expect(mutations).toEqual([]);expect(state.writes).toBe(writes);expect(JSON.stringify(state.drafts)).toBe(before);
  });
}

test('native address cancellation preserves bag and merchant switch clears checkout',async({page})=>{
  await setup(page);await ready(page);const ios=await openNativeBag(page);
  await accountSection(ios, 'Addresses'); await ios.getByRole('button',{name:'Add delivery address',exact:true}).click();
  await fillPreviewAddress(ios);
  await ios.getByRole('button',{name:'Cancel',exact:true}).click();
  await expect(ios.getByLabel('Current quantity')).toHaveText('1');
  await expect(ios.getByRole('button',{name:'Add delivery address',exact:true})).toBeFocused();
  await accountSection(ios, 'Addresses'); await ios.getByRole('button',{name:'Add delivery address',exact:true}).click();
  await expect(ios.getByLabel('Street and address')).toHaveValue('');
  await page.getByRole('combobox',{name:'Merchant',exact:true}).selectOption(other);
  await ios.getByRole('button',{name:'Cart',exact:true}).click();
  await expect(ios.getByText('Your bag is empty')).toBeVisible();
  await expect(ios.getByRole('dialog')).toHaveCount(0);
});

test('preview search sends catalog filters, paginates and opens shoppable results', async ({ page }) => {
  const state=await setup(page); const requests: URL[]=[];
  await page.route('**/app-preview/catalog?**', async route => {
    const url=new URL(route.request().url()); if (!url.searchParams.has('q')) return route.fallback(); requests.push(url);
    const offset=Number(url.searchParams.get('offset') || 0), q=url.searchParams.get('q');
    await route.fulfill({json:{merchantId:mid,locale:'en',source:'https://grocery.rocento.com',categories:[],total:q==='missing' ? 0 : 25,nextOffset:!offset && q!=='missing' ? 24 : null,products:q==='missing' ? [] : [{id:offset ? 'page-two' : 'search-apple',name:offset ? 'Second page apple' : 'Search apple',price:offset ? '4.00' : '3.00',originalPrice:null,currency:'USD',unit:'each',inStock:true,imageUrl:null}]}});
  });
  await ready(page); const ios=page.getByTestId('preview-iOS'); const before=JSON.stringify(state.drafts);
  await ios.getByRole('button',{name:'Search store'}).click();
  await openFilterSheet(ios); await ios.getByLabel('Search products',{exact:true}).fill('apple');
  await ios.getByRole('combobox',{name:'Category',exact:true}).selectOption('7edd7367-5330-47c4-8fa9-73c18f23ea67');
  await ios.getByLabel('Sort by').selectOption('price_asc');
  await openFilterSheet(ios); await ios.getByLabel('Min price').fill('2'); await ios.getByLabel('Max price').fill('5'); await ios.getByLabel('In stock only').check();
  await ios.getByRole('button',{name:'Show results',exact:true}).click();
  await expect(ios.getByRole('button',{name:'View Search apple'})).toBeVisible();
  expect(Object.fromEntries(requests.at(-1)!.searchParams)).toMatchObject({q:'apple',collection:'7edd7367-5330-47c4-8fa9-73c18f23ea67',sort:'price_asc',min_price:'2',max_price:'5',in_stock:'true',offset:'0'});
  await ios.getByRole('button',{name:'Load more products'}).click();
  await expect(ios.getByRole('button',{name:'View Second page apple'})).toBeVisible();
  await expect(ios.getByRole('button',{name:'View Search apple'})).toBeVisible();
  expect(requests.at(-1)!.searchParams.get('offset')).toBe('24');
  await ios.getByRole('button',{name:'View Second page apple'}).click();
  await ios.getByRole('button',{name:'Add to cart',exact:true}).click();
  await ios.getByRole('button',{name:'Back',exact:true}).click();
  await openFilterSheet(ios); await expect(ios.getByLabel('Search products',{exact:true})).toHaveValue('apple');
  await openFilterSheet(ios); await ios.getByLabel('Search products',{exact:true}).fill('missing');
  await ios.getByRole('button',{name:'Show results',exact:true}).click();
  await expect(ios.getByText('No products match.',{exact:false})).toBeVisible();
  await openFilterSheet(ios); await ios.getByRole('button',{name:'Reset',exact:true}).click();
  await openFilterSheet(ios); await expect(ios.getByLabel('Search products',{exact:true})).toHaveValue('');
  await ios.getByRole('button',{name:'Show results',exact:true}).click(); await expect(ios.getByRole('button',{name:'View Search apple'})).toBeVisible();
  expect(JSON.stringify(state.drafts)).toBe(before);
});

test('preview search validates ranges and retries failures', async ({ page }) => {
  await setup(page); let fail=true;
  await page.route('**/app-preview/catalog?**', route => { const url=new URL(route.request().url()); if(!url.searchParams.has('q')) return route.fallback(); return fail ? route.fulfill({status:503,json:{error:'Unavailable'}}) : route.fallback(); });
  await ready(page); const ios=page.getByTestId('preview-iOS'); await ios.getByRole('button',{name:'Search store'}).click();
  await expect(ios.getByRole('alert')).toContainText('could not be loaded');
  fail=false; await ios.getByRole('button',{name:'Retry search'}).click(); await expect(ios.getByRole('button',{name:'View Red grapes'})).toBeVisible();
  await openFilterSheet(ios); await ios.getByLabel('Min price').fill('10'); await ios.getByLabel('Max price').fill('1');
  await expect(ios.getByRole('button',{name:'Show results',exact:true})).toBeDisabled();
  await expect(ios.getByRole('alert')).toContainText('Enter a valid price range');
});

test('preview search discards stale terms and resets merchant and locale scope', async ({ page }) => {
  await setup(page);
  await page.route('**/app-preview/catalog?**', async route => {
    const url=new URL(route.request().url()); if(!url.searchParams.has('q')) return route.fallback();
    const q=url.searchParams.get('q'); if(q==='slow') await new Promise(resolve=>setTimeout(resolve,500));
    await route.fulfill({json:{merchantId:url.pathname.split('/')[4],locale:url.searchParams.get('locale'),source:'https://grocery.rocento.com',categories:[],total:1,nextOffset:null,products:[{id:q || 'all',name:q==='slow' ? 'Old search result' : 'Current search result',price:'1',originalPrice:null,currency:'USD',unit:'each',inStock:true,imageUrl:null}]}}).catch(()=>{});
  });
  await ready(page); const ios=page.getByTestId('preview-iOS'); await ios.getByRole('button',{name:'Search store'}).click();
  await openFilterSheet(ios); await ios.getByLabel('Search products',{exact:true}).fill('slow'); await ios.getByRole('button',{name:'Show results',exact:true}).click();
  await openFilterSheet(ios); await ios.getByLabel('Search products',{exact:true}).fill('new'); await ios.getByRole('button',{name:'Show results',exact:true}).click();
  await expect(ios.getByRole('button',{name:'View Current search result'})).toBeVisible();
  await page.waitForTimeout(600); await expect(ios.getByText('Old search result')).toHaveCount(0);
  await page.getByLabel('Preview language').selectOption('ar'); await openFilterSheet(ios); await expect(ios.getByRole('searchbox',{name:'البحث عن المنتجات',exact:true})).toHaveValue('');
  await page.getByLabel('Preview language').selectOption('en');
  await page.getByRole('combobox',{name:'Merchant',exact:true}).selectOption(other);
  await ios.getByRole('button',{name:'Search store'}).click(); await openFilterSheet(ios); await expect(ios.getByLabel('Search products',{exact:true})).toHaveValue('');
});

test('native previews have independent navigation, product sheets and account sessions', async ({ page }) => {
  const state = await setup(page); await ready(page);
  const ios = page.getByTestId('preview-iOS'), android = page.getByTestId('preview-Android');
  const writes = state.writes;
  await expect(ios.getByRole('button',{name:'Choose delivery location',exact:true})).toBeVisible();
  await expect(android.locator('.ms-native-large-title')).toHaveCount(0);
  await expect(ios.locator('.ms-section-edit')).toHaveCount(0);
  await ios.locator('.ms-hero').click();
  await expect(ios.getByRole('button', {name:'Categories',exact:true})).toHaveAttribute('aria-current','page');
  await expect(android.getByRole('button', {name:'Home',exact:true})).toHaveAttribute('aria-current','page');
  await ios.getByRole('button', {name:'View Red grapes'}).click();
  await expect(ios.getByRole('dialog', {name:'Product'})).toBeVisible();
  await expect(android.getByRole('dialog')).toHaveCount(0);
  await expect(ios.getByRole('button',{name:'Back',exact:true})).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(ios.getByRole('dialog')).toHaveCount(0);
  await expect(ios.getByRole('button',{name:'View Red grapes'})).toBeFocused();
  await android.getByRole('button',{name:'View Red grapes'}).click();
  await expect(android.locator('.ms-sheet-handle')).toHaveCount(0);
  await android.getByRole('button',{name:'Back',exact:true}).click();
  await ios.getByRole('button',{name:'Account',exact:true}).click();
  await accountSection(ios, 'Home'); await ios.getByRole('button',{name:'Sign out',exact:true}).click();
  await ios.getByRole('button',{name:'Sign in',exact:true}).click();
  await expect(ios.getByRole('heading',{name:'Welcome back',exact:true})).toBeVisible();
  await ios.locator('.ms-phone').screenshot({path:'../output/mobile-account-polish-20261012/preview-login.png'});
  await ios.getByRole('button',{name:'Create account',exact:true}).click();
  await expect(ios.getByLabel('Confirm password',{exact:true})).toBeVisible();
  await ios.locator('.ms-phone').screenshot({path:'../output/mobile-account-polish-20261012/preview-register.png'});
  await ios.getByRole('button',{name:'Back to sign in',exact:true}).click();
  await ios.getByLabel('Email or phone',{exact:true}).fill('preview@example.com');await ios.getByLabel('Password',{exact:true}).fill('preview-password');await ios.getByRole('button',{name:'Sign in',exact:true}).click();
  await expect(ios.getByRole('button',{name:'Sign out',exact:true})).toBeVisible();
  await ios.getByRole('button',{name:'App settings',exact:true}).click();await ios.getByLabel('App language',{exact:true}).selectOption('ar');
  await expect(ios).toHaveAttribute('dir','rtl');
  await expect(android).toHaveAttribute('dir','ltr');
  expect(state.writes).toBe(writes);
  expect(state.apiPaths.some(path => /checkout|orders|\/cart/.test(path))).toBe(false);
});

test('native preview layout follows tokens and fits both device sizes', async ({ page }) => {
  await setup(page); await ready(page);
  for (const width of ['320','390']) {
    await page.getByLabel('Device width').selectOption(width);
    for (const platform of ['iOS','Android']) {
      const device = page.getByTestId('preview-'+platform);
      const phone = device.locator('.ms-phone');
      const measurements = await phone.evaluate(el => ({width: el.clientWidth, scroll: el.scrollWidth, radius: getComputedStyle(el).getPropertyValue('--phone-radius').trim(), spacing: getComputedStyle(el).getPropertyValue('--phone-space').trim()}));
      expect(measurements.scroll).toBeLessThanOrEqual(measurements.width);
      expect(['0px','8px','18px','28px']).toContain(measurements.radius);
      expect(['12px','20px']).toContain(measurements.spacing);
      await phone.screenshot({path:`test-results/mobile-studio/native-${platform}-${width}.png`});
      await device.getByRole('button', {name:'Account',exact:true}).click();
      const accountSize = await phone.evaluate(el => ({width:el.clientWidth, scroll:el.scrollWidth}));
      expect(accountSize.scroll).toBeLessThanOrEqual(accountSize.width);
      await phone.screenshot({path:`../output/mobile-account-polish-20261012/account-${platform}-${width}.png`});
      await device.getByRole('button', {name:'Home',exact:true}).click();
    }
  }
  await page.getByLabel('Preview language').selectOption('ar');
  await expect(page.getByLabel('Preview appearance')).toHaveCount(0);
  await page.getByLabel('Show section editing controls').check();
  await expect(page.getByTestId('preview-iOS').locator('.ms-section-edit').first()).toBeVisible();
  await page.screenshot({path:'test-results/mobile-studio/native-arabic.png',fullPage:true});
});

for (const platform of ['iOS','Android']) {
  test(`native ${platform} scheduled pickup requires every source and invalidates changed quotes`,async({page})=>{
    await setup(page);await ready(page);const d=await openNativeBag(page,platform);
    await d.getByText('Checkout preview settings',{exact:true}).click();
    await d.getByLabel('Multiple fulfillment sources').check();
    if(platform==='iOS') await d.getByLabel('Fulfillment',{exact:true}).selectOption('pickup');
    else await d.getByRole('button',{name:'Pickup',exact:true}).click();
    await d.getByRole('button',{name:'Check availability',exact:true}).click();
    await expect(d.getByRole('alert')).toContainText('Choose a pickup branch');
    if(platform==='iOS') await d.getByLabel('Pickup branch',{exact:true}).selectOption('central');
    else await d.getByRole('button',{name:'Demo central branch',exact:true}).click();
    await d.getByRole('switch',{name:'As soon as possible'}).uncheck();
    await d.getByLabel(platform==='iOS'?'Delivery date':'Delivery date (YYYY-MM-DD)',{exact:true}).fill('2099-10-13');
    await d.getByRole('button',{name:'Check availability',exact:true}).click();
    await d.getByRole('button',{name:'Review order',exact:true}).click();
    await expect(d.getByRole('alert')).toContainText('every fulfillment source');
    await d.locator('.ms-native-slots').nth(0).getByRole('button').first().click();
    await d.getByRole('button',{name:'Review order',exact:true}).click();
    await expect(d.getByRole('alert')).toContainText('every fulfillment source');
    await d.locator('.ms-native-slots').nth(1).getByRole('button').last().click();
    await d.getByRole('button',{name:'Review order',exact:true}).click();
    await expect(d.locator('.ms-native-quote-total')).toContainText('$2.75');
    await d.getByRole('button',{name:'Add one Red grapes'}).click();
    await expect(d.locator('.ms-native-quote')).toHaveCount(0);
    await expect(d.getByRole('button',{name:'Review order',exact:true})).toHaveCount(0);
    await d.getByRole('switch',{name:'As soon as possible'}).check();
    await d.getByRole('button',{name:'Check availability',exact:true}).click();
    await d.getByRole('button',{name:'Review order',exact:true}).click();
    await expect(d.locator('.ms-native-quote-total')).toContainText('$5.50');
    await d.getByRole('button',{name:'Place order',exact:true}).click();
    for(let n=0;n<4;n++) await orderPreviewAction(d,'Simulate next status');
    await expect(d.locator('.ms-native-order-status')).toHaveText('Picked up');
  });
}

test('native pending confirmation locks edits and retries the same order once',async({page})=>{
  await setup(page);await ready(page);const d=await openNativeBag(page);
  await saveNativeAddress(d);
  await d.getByText('Checkout preview settings',{exact:true}).click();
  await d.getByLabel('Test scenario',{exact:true}).selectOption('pending');
  await d.getByRole('button',{name:'Check availability',exact:true}).click();
  await d.getByRole('button',{name:'Review order',exact:true}).click();
  await d.getByRole('button',{name:'Place order',exact:true}).click();
  await expect(d.getByRole('alert')).toContainText('pending');
  await expect(d.getByRole('button',{name:'Add one Red grapes'})).toBeDisabled();
  await expect(d.getByLabel('Test scenario',{exact:true})).toBeDisabled();
  await d.getByRole('button',{name:'Account',exact:true}).click();
  await accountSection(d, 'Addresses'); await expect(d.getByRole('button',{name:'Add delivery address',exact:true})).toBeDisabled();
  await d.getByRole('button',{name:/^Cart/}).click();
  await d.getByRole('button',{name:'Retry confirmation',exact:true}).evaluate((button:HTMLButtonElement)=>{button.click();button.click();});
  await expect(d.getByText('Your order is confirmed',{exact:true})).toBeVisible();
  await d.getByRole('button',{name:'Account',exact:true}).click();
  await accountSection(d, 'Orders'); await expect(d.locator('.ms-native-order-link')).toHaveCount(1);
});

test('native checkout failures retain bag and recover without customer requests',async({page})=>{
  await setup(page);await ready(page);const d=await openNativeBag(page);
  await saveNativeAddress(d);
  await d.getByText('Checkout preview settings',{exact:true}).click();
  for(const scenario of ['delivery','stock','expired','rejected','verification']) {
    await d.getByLabel('Test scenario',{exact:true}).selectOption(scenario);
    if(scenario==='stock') await expect(d.getByRole('button',{name:'Check availability',exact:true})).toBeDisabled();
    else {
      await d.getByRole('button',{name:'Check availability',exact:true}).click();
      if(scenario!=='delivery') {
        await d.getByRole('button',{name:'Review order',exact:true}).click();
        if(scenario!=='verification') await d.getByRole('button',{name:'Place order',exact:true}).click();
      }
      await expect(d.getByRole('alert')).toBeVisible();
    }
    await expect(d.getByLabel('Current quantity')).toHaveText('1');
    await expect(d.getByText('Your order is confirmed',{exact:true})).toHaveCount(0);
    await d.getByRole('button',{name:'Reset scenario',exact:true}).click();
  }
  await d.getByRole('button',{name:'Check availability',exact:true}).click();
  await d.getByRole('button',{name:'Review order',exact:true}).click();
  await d.getByRole('button',{name:'Expire quote now',exact:true}).click();
  await expect(d.getByRole('alert')).toContainText('expired');
  await d.getByRole('button',{name:'Place order',exact:true}).click();
  await expect(d.locator('.ms-native-quote')).toHaveCount(0);
  await d.getByRole('button',{name:'Check availability',exact:true}).click();
  await d.getByRole('button',{name:'Review order',exact:true}).click();
  await d.getByRole('button',{name:'Place order',exact:true}).click();
  await expect(d.getByText('Your order is confirmed',{exact:true})).toBeVisible();
});

test('native address map requires a pin and denied location can be retried',async({page})=>{
  await setup(page);await ready(page);const ios=await openNativeBag(page);
  await accountSection(ios,'Addresses');await ios.getByRole('button',{name:'Add delivery address',exact:true}).click();
  await ios.getByLabel('Street and address').fill('Test street');
  await expect(ios.getByRole('button',{name:'Save address',exact:true})).toBeDisabled();
  await fillPreviewAddress(ios);
  await expect(ios.getByRole('button',{name:'Save address',exact:true})).toBeEnabled();
  await ios.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.context().clearPermissions();
  await page.evaluate(()=>{const geo=navigator.geolocation;const original=geo.getCurrentPosition.bind(geo);geo.getCurrentPosition=(_success,error)=>{geo.getCurrentPosition=original;error?.({code:1,message:'Permission denied',PERMISSION_DENIED:1,POSITION_UNAVAILABLE:2,TIMEOUT:3});};});
  const android=await openNativeBag(page,'Android');
  await accountSection(android,'Addresses');await android.getByRole('button',{name:'Add delivery address',exact:true}).click();
  await android.getByRole('button',{name:'Use current location',exact:true}).click();
  await expect(android.getByRole('dialog').getByRole('status')).toContainText('Current location is unavailable');
  await fillPreviewAddress(android);
  await android.getByRole('button',{name:'Save address',exact:true}).click();
  await expect(android.getByRole('dialog')).toHaveCount(0);
});

test('order history survives reload, tracks delivery and isolates merchant and device',async({page})=>{
  const state=await setup(page);await ready(page);const d=await openNativeBag(page), before=JSON.stringify(state.drafts), mutations:string[]=[];
  page.on('request',r=>{if(!['GET','HEAD','OPTIONS'].includes(r.method()))mutations.push(r.url())});
  await saveNativeAddress(d);
  await d.getByRole('button',{name:'Check availability',exact:true}).click();await d.getByRole('button',{name:'Review order',exact:true}).click();
  await d.getByRole('button',{name:'Place order',exact:true}).evaluate((b:HTMLButtonElement)=>{b.click();b.click()});
  await expect(d.getByRole('region',{name:'Order details'})).toContainText('Red grapes × 1');
  for(const status of ['Confirmed','Preparing','Shipped','Out for delivery','Delivered']){
    await orderPreviewAction(d,'Simulate next status');await expect(d.locator('.ms-native-order-status')).toHaveText(status);
  }
  await expect(d.getByRole('button',{name:'Tracking complete'})).toBeDisabled();await expect(d.locator('.ms-order-timeline li.is-complete')).toHaveCount(6);
  await page.reload();await ready(page);await d.getByRole('button',{name:'Account',exact:true}).click();await accountSection(d, 'Orders'); await expect(d.locator('.ms-native-order-link')).toHaveCount(1);await accountSection(d, 'Orders'); await d.locator('.ms-native-order-link').click();await openOrderPreviewTools(d);
  await expect(d.locator('.ms-native-order-status')).toHaveText('Delivered');await expect(d.getByRole('region',{name:'Order details'})).toContainText('Red grapes × 1');
  const android=page.getByTestId('preview-Android');await android.getByRole('button',{name:'Account',exact:true}).click();await expect(android.getByText('No orders yet',{exact:true})).toBeVisible();
  await page.getByRole('combobox',{name:'Merchant',exact:true}).selectOption(other);await d.getByRole('button',{name:'Account',exact:true}).click();await expect(d.getByText('No orders yet',{exact:true})).toBeVisible();
  await page.getByRole('combobox',{name:'Merchant',exact:true}).selectOption(mid);await d.getByRole('button',{name:'Account',exact:true}).click();await accountSection(d, 'Orders'); await expect(d.locator('.ms-native-order-link')).toHaveCount(1);
  await accountSection(d, 'Home'); await d.getByRole('button',{name:'Sign out',exact:true}).click();await expect(d.locator('.ms-native-order-link')).toHaveCount(0);await d.getByLabel('Email or phone',{exact:true}).fill('preview@example.com');await d.getByLabel('Password',{exact:true}).fill('preview-password');await d.getByRole('button',{name:'Sign in',exact:true}).click();await accountSection(d, 'Orders'); await expect(d.locator('.ms-native-order-link')).toHaveCount(1);
  await page.getByLabel('Preview language').selectOption('ar');await accountSection(d, 'Orders'); await d.locator('.ms-native-order-link').click();await openOrderPreviewTools(d);await expect(d.getByRole('list',{name:'سجل حالات الطلب'})).toBeVisible();
  await page.getByLabel('Preview language').selectOption('en');await accountSection(d, 'Home'); await d.getByRole('button',{name:'Clear saved preview data',exact:true}).click();await expect(d.getByText('No orders yet',{exact:true})).toBeVisible();
  await page.reload();await ready(page);await d.getByRole('button',{name:'Account',exact:true}).click();await expect(d.getByText('No orders yet',{exact:true})).toBeVisible();
  expect(mutations).toEqual([]);expect(JSON.stringify(state.drafts)).toBe(before);
});

test('native address edits preserve one saved address and survive reload per device',async({page})=>{
  await setup(page);await ready(page);const d=await openNativeBag(page);
  await saveNativeAddress(d);
  await d.getByRole('button',{name:'Account',exact:true}).click();
  await accountSection(d, 'Addresses'); await d.getByText('Saved preview addresses',{exact:true}).click();
  await d.getByRole('button',{name:'Edit address',exact:true}).click();
  await expect(d.getByText('Pin selected. You can move it on the map.',{exact:true})).toBeVisible();
  await fillPreviewAddress(d);
  await d.getByLabel('Street and address').fill('Edited native street');
  await d.getByRole('button',{name:'Save address',exact:true}).click();
  await expect(d.locator('.ms-saved-address')).toHaveCount(1);
  await expect(d.locator('.ms-saved-address')).toContainText('Edited native street');
  await page.reload();await ready(page);
  await d.getByRole('button',{name:'Account',exact:true}).click();
  await accountSection(d, 'Addresses'); await d.getByText('Saved preview addresses',{exact:true}).click();
  await expect(d.locator('.ms-saved-address')).toHaveCount(1);
  await d.getByRole('button',{name:'Edit address',exact:true}).click();
  await expect(d.getByLabel('Street and address')).toHaveValue('Edited native street');
  await expect(d.getByText('Pin selected. You can move it on the map.',{exact:true})).toBeVisible();
});

test('invalid stored test orders are ignored safely',async({page})=>{
  await page.addInitScript(merchant=>sessionStorage.setItem(`rocento:preview-orders:v1:${merchant}:iOS`,'[{"id":"PREVIEW-invalid"}]'),mid);
  await setup(page);await ready(page);const d=page.getByTestId('preview-iOS');await d.getByRole('button',{name:'Account',exact:true}).click();await expect(d.getByText('No orders yet',{exact:true})).toBeVisible();
});

async function placePostPurchaseOrder(page:Page){
  await setup(page);await ready(page);const d=await openNativeBag(page);await saveNativeAddress(d);
  await d.getByRole('button',{name:'Check availability',exact:true}).click();await d.getByRole('button',{name:'Review order',exact:true}).click();await d.getByRole('button',{name:'Place order',exact:true}).click();return d;
}
test('cancellation reason, refund failure retry, persistence and stopped tracking stay simulated',async({page})=>{
  const d=await placePostPurchaseOrder(page),mutations:string[]=[];page.on('request',r=>{if(!['GET','HEAD','OPTIONS'].includes(r.method()))mutations.push(r.url())});
  await orderPreviewAction(d,'Cancel test order');await expect(d.getByRole('button',{name:'Confirm cancellation',exact:true})).toBeDisabled();
  await d.getByRole('button',{name:'Keep order',exact:true}).click();await expect(d.locator('.ms-native-order-status')).toHaveText('Order placed');
  await orderPreviewAction(d,'Cancel test order');await d.getByLabel('Cancellation reason').selectOption('wrong_items');await d.getByLabel('Simulate a paid order to test refunds').check();await d.getByRole('button',{name:'Confirm cancellation',exact:true}).click();
  await expect(d.locator('.ms-native-order-status')).toHaveText('Cancelled');await expect(d.getByRole('button',{name:'Order cancelled',exact:true})).toBeDisabled();
  await d.getByRole('button',{name:'Simulate refund failure',exact:true}).click();await expect(d.getByText('Simulated refund failed. You can retry.',{exact:true})).toBeVisible();await d.getByRole('button',{name:'Retry test refund',exact:true}).click();await d.getByRole('button',{name:'Simulate refund success',exact:true}).click();
  await page.reload();await ready(page);await d.getByRole('button',{name:'Account',exact:true}).click();await accountSection(d,'Orders');await expect(d.locator('.ms-native-order-link')).toContainText('Cancelled');await accountSection(d, 'Orders'); await d.locator('.ms-native-order-link').click();await openOrderPreviewTools(d);await expect(d.getByText('Simulated refund completed',{exact:true})).toBeVisible();await expect(d.getByRole('button',{name:'Simulate refund success',exact:true})).toHaveCount(0);
  await page.getByLabel('Preview language').selectOption('ar');await openOrderPreviewTools(d);await expect(d.getByRole('region',{name:'الإلغاء والاسترداد'})).toBeVisible();expect(mutations).toEqual([]);
});
test('cash cancellation needs no refund and shipped orders cannot be cancelled',async({page})=>{
  const d=await placePostPurchaseOrder(page);await orderPreviewAction(d,'Cancel test order');await d.getByLabel('Cancellation reason').selectOption('changed_mind');await d.getByRole('button',{name:'Confirm cancellation',exact:true}).click();await expect(d.getByText('No refund required. Cash on delivery was not collected.',{exact:true})).toBeVisible();
  await orderPreviewAction(d,'Buy again');await d.getByRole('button',{name:'Add available items to cart',exact:true}).click();
  await d.getByRole('button',{name:'Check availability',exact:true}).click();await d.getByRole('button',{name:'Review order',exact:true}).click();await d.getByRole('button',{name:'Place order',exact:true}).click();
  for(let i=0;i<3;i++)await orderPreviewAction(d,'Simulate next status');await expect(d.locator('.ms-native-order-status')).toHaveText('Shipped');await expect(d.getByRole('button',{name:'Cancel test order',exact:true})).toHaveCount(0);
});
test('buy again fetches current prices by ID and handles unavailable items and retries',async({page})=>{
  const d=await placePostPurchaseOrder(page);let fail=true,stock=true;const mutations:string[]=[];page.on('request',r=>{if(!['GET','HEAD','OPTIONS'].includes(r.method()))mutations.push(r.url())});
  await page.route('**/app-preview/catalog?**',route=>{const url=new URL(route.request().url());if(!url.searchParams.has('q'))return route.fallback();return route.fulfill(fail?{status:503,json:{error:'Unavailable'}}:{json:{merchantId:mid,locale:'en',products:[{id:'6d1bff50-62ba-40bc-baf2-c9ef685250d1',name:'Renamed grapes',price:'4.25',currency:'USD',inStock:stock,unit:'pack',imageUrl:null,originalPrice:null}],nextOffset:null}})});
  await orderPreviewAction(d,'Buy again');await expect(d.getByRole('alert')).toContainText('Nothing was added');await expect(d.getByText('Your bag is empty',{exact:true})).toBeVisible();
  fail=false;stock=false;await orderPreviewAction(d,'Buy again');await expect(d.getByRole('region',{name:'Review reorder'})).toContainText('Out of stock');await expect(d.getByRole('button',{name:'Add available items to cart',exact:true})).toBeDisabled();
  stock=true;await orderPreviewAction(d,'Buy again');await expect(d.getByRole('region',{name:'Review reorder'})).toContainText('Now: $4.25');await d.getByRole('button',{name:'Add available items to cart',exact:true}).evaluate((b:HTMLButtonElement)=>{b.click();b.click()});await expect(d.getByLabel('Current quantity')).toHaveText('1');await expect(d.locator('.ms-native-bag-line')).toContainText('$4.25');await expect(d.getByRole('region',{name:'Order details'})).toContainText('Red grapes × 1');expect(mutations).toEqual([]);
});

test('partial reorder scans pages and skips missing items without exceeding cart limits',async({page})=>{
  const d=await placePostPurchaseOrder(page);
  await page.evaluate(merchant=>{const key=`rocento:preview-orders:v1:${merchant}:iOS`,orders=JSON.parse(sessionStorage.getItem(key)!);orders[0].lines[0].quantity=99;orders[0].lines.push({quantity:1,product:{...orders[0].lines[0].product,id:'removed-product',name:'Removed item'}});sessionStorage.setItem(key,JSON.stringify(orders));},mid);
  await page.reload();await ready(page);await d.getByRole('button',{name:'Account',exact:true}).click();await accountSection(d, 'Orders'); await d.locator('.ms-native-order-link').click();await openOrderPreviewTools(d);const offsets:number[]=[];
  await page.route('**/app-preview/catalog?**',route=>{const url=new URL(route.request().url());if(!url.searchParams.has('q'))return route.fallback();const offset=Number(url.searchParams.get('offset'));offsets.push(offset);return route.fulfill({json:{merchantId:mid,locale:'en',products:offset?[{id:'6d1bff50-62ba-40bc-baf2-c9ef685250d1',name:'Grapes now',price:'3.00',currency:'USD',inStock:true}]:[],nextOffset:offset?null:24}})});
  await orderPreviewAction(d,'Buy again');const review=d.getByRole('region',{name:'Review reorder'});await expect(review).toContainText('Unavailable or could not be verified');await d.getByRole('button',{name:'Add available items to cart',exact:true}).click();await d.getByRole('button',{name:/^Cart/}).click();await expect(d.getByLabel('Current quantity')).toHaveText('99');
  await d.getByRole('button',{name:'Account',exact:true}).click();await orderPreviewAction(d,'Buy again');await expect(review).toContainText('Cart quantity limit reached');await expect(d.getByRole('button',{name:'Add available items to cart',exact:true})).toBeDisabled();expect(offsets).toEqual([0,24,0,24]);
});

test('percentage promotion rounds consistently through checkout, history and refund',async({page})=>{
  await setup(page);await ready(page);const d=await openNativeBag(page),promo=d.getByRole('region',{name:'Promo codes and totals'}),mutations:string[]=[];page.on('request',r=>{if(!['GET','HEAD','OPTIONS'].includes(r.method()))mutations.push(r.url())});
  await d.getByLabel('Enter promo code').fill(' save10 ');await d.getByRole('button',{name:'Apply code',exact:true}).click();await expect(promo).toContainText('Estimated total: $7.47');
  await saveNativeAddress(d);await d.getByRole('button',{name:'Check availability',exact:true}).click();await d.getByRole('button',{name:'Review order',exact:true}).click();await expect(d.locator('.ms-native-quote-total')).toHaveText('Total: $7.47');await d.getByRole('button',{name:'Place order',exact:true}).click();
  const detail=d.getByRole('region',{name:'Order details'});await expect(detail).toContainText('Promo code: SAVE10');await expect(detail.locator('.ms-checkout-total')).toContainText('$7.47');
  await orderPreviewAction(d,'Cancel test order');await d.getByLabel('Cancellation reason').selectOption('changed_mind');await d.getByLabel('Simulate a paid order to test refunds').check();await d.getByRole('button',{name:'Confirm cancellation',exact:true}).click();await expect(d.getByRole('region',{name:'Cancellation and refund'})).toContainText('Test refund amount: $7.47');
  await page.reload();await ready(page);await d.getByRole('button',{name:'Account',exact:true}).click();await accountSection(d, 'Orders'); await d.locator('.ms-native-order-link').click();await openOrderPreviewTools(d);await expect(detail).toContainText('Promo code: SAVE10');await expect(detail.locator('.ms-checkout-total')).toContainText('$7.47');expect(mutations).toEqual([]);
});
test('fixed and free delivery promotions cap discounts, replace codes and invalidate reviewed totals',async({page})=>{
  await setup(page);await ready(page);const d=await openNativeBag(page),promo=d.getByRole('region',{name:'Promo codes and totals'});
  await d.getByLabel('Enter promo code').fill('SAVE5');await d.getByRole('button',{name:'Apply code',exact:true}).click();await expect(promo).toContainText('Estimated total: $5.00');
  await saveNativeAddress(d);await d.getByRole('button',{name:'Check availability',exact:true}).click();await d.getByRole('button',{name:'Review order',exact:true}).click();await expect(d.locator('.ms-native-quote-total')).toHaveText('Total: $5.00');
  await d.getByLabel('Enter promo code').fill('FREESHIP');await d.getByRole('button',{name:'Apply code',exact:true}).click();await expect(d.locator('.ms-native-quote-total')).toHaveCount(0);await expect(promo).toContainText('Estimated total: $2.75');
  await d.getByLabel('Fulfillment',{exact:true}).selectOption('pickup');await expect(promo.getByRole('alert')).toContainText('delivery only');await d.getByLabel('Pickup branch',{exact:true}).selectOption('central');await d.getByRole('button',{name:'Check availability',exact:true}).click();await expect(d.getByRole('button',{name:'Review order',exact:true})).toHaveCount(0);
  await d.getByRole('button',{name:'Remove promo',exact:true}).click();await expect(promo).toContainText('Estimated total: $2.75');
  await d.getByLabel('Fulfillment',{exact:true}).selectOption('delivery');await d.getByLabel('Enter promo code').fill('FREESHIP');await d.getByRole('button',{name:'Apply code',exact:true}).click();await d.getByRole('button',{name:'Check availability',exact:true}).click();await d.getByRole('button',{name:'Review order',exact:true}).click();await d.getByRole('button',{name:'Place order',exact:true}).click();await expect(d.getByRole('region',{name:'Order details'})).toContainText('Delivery savings: $5.00');
});
test('invalid expired excluded and minimum-spend promos leave cart intact and remain device scoped',async({page})=>{
  await setup(page);await ready(page);const d=await openNativeBag(page),promo=d.getByRole('region',{name:'Promo codes and totals'});
  for(const [code,message] of [['UNKNOWN','Invalid preview code'],['EXPIRED','expired'],['MIN50','at least 50']]){await d.getByLabel('Enter promo code').fill(code);await d.getByRole('button',{name:'Apply code',exact:true}).click();await expect(promo.getByRole('alert')).toContainText(message);await expect(d.getByLabel('Current quantity')).toHaveText('1');}
  for(let i=1;i<19;i++)await d.getByRole('button',{name:'Add one Red grapes'}).click();await d.getByLabel('Enter promo code').fill('MIN50');await d.getByRole('button',{name:'Apply code',exact:true}).click();await expect(promo).toContainText('Estimated total: $52.25');await d.getByRole('button',{name:'Remove one Red grapes'}).click();await expect(promo.getByRole('alert')).toContainText('at least 50');await expect(promo).toContainText('Estimated total: $54.50');
  const android=await openNativeBag(page,'Android');await expect(android.getByRole('region',{name:'Promo codes and totals'})).not.toContainText('Selected code');
  await d.getByRole('button',{name:'Remove promo',exact:true}).click();await page.getByLabel('Preview language').selectOption('ar');await expect(d.getByRole('region',{name:'رموز الخصم والإجماليات'})).toBeVisible();
});

for(const platform of ['iOS','Android']) {
  test(`native ${platform} registration verification and password reset match account rules`,async({page})=>{
    const state=await setup(page);await ready(page);const d=page.getByTestId(`preview-${platform}`),before=JSON.stringify(state.drafts),mutations:string[]=[];
    page.on('request',r=>{if(!['GET','HEAD','OPTIONS'].includes(r.method()))mutations.push(r.url())});
    const press=async(name:string)=>d.getByRole('button',{name,exact:true}).click();
    const fill=async(name:string,value:string)=>d.getByLabel(name,{exact:true}).fill(value);
    await press('Account');await press('Sign out');await press('Sign in');
    await expect(d.getByRole('alert')).toHaveText('Enter your email or phone number.');
    await fill('Email or phone','demo@example.com');await press('Sign in');
    await expect(d.getByRole('alert')).toHaveText('Enter your password.');
    await fill('Password','temporary');await d.getByRole('switch',{name:'Show password',exact:true}).check();
    await expect(d.getByLabel('Password',{exact:true})).toHaveAttribute('type','text');
    await press('Create account');
    await expect(d.getByLabel('Email or phone',{exact:true})).toHaveValue('demo@example.com');
    await expect(d.getByLabel('Password',{exact:true})).toHaveValue('');
    await expect(d.getByRole('switch',{name:'Show password',exact:true})).not.toBeChecked();
    for(const password of ['short','أ'.repeat(65)]) {
      await fill('Password',password);await fill('Confirm password',password);await press('Create account');
      await expect(d.getByRole('alert')).toContainText('12–128 UTF-8 bytes');
    }
    await fill('Password','أ'.repeat(6));await fill('Confirm password','different');await press('Create account');
    await expect(d.getByRole('alert')).toHaveText('Passwords do not match.');
    await fill('Confirm password','أ'.repeat(6));await press('Create account');
    await expect(d.getByRole('heading',{name:'Verify account',exact:true})).toBeVisible();
    await expect(d.getByRole('status')).toContainText('Preview only: no message sent');
    await press('Verify account');await expect(d.getByRole('alert')).toContainText('Enter the verification code');
    await press('Send a new code');await expect(d.getByRole('status')).toContainText('If eligible');
    await fill('Verification code','000000');await press('Verify account');
    await expect(d.getByRole('heading',{name:'Welcome back'})).toBeVisible();
    await press('Forgot password?');await expect(d.getByLabel('Password',{exact:true})).toHaveCount(0);
    await press('Send reset code');await expect(d.getByRole('heading',{name:'Reset password',exact:true})).toBeVisible();
    await expect(d.getByLabel('Email or phone',{exact:true})).toHaveValue('demo@example.com');
    await fill('Password','new-demo-password');await fill('Confirm password','new-demo-password');await fill('Verification code','000000');await press('Reset password');
    await expect(d.getByRole('status')).toContainText('Password updated');await expect(d.getByLabel('Password',{exact:true})).toHaveValue('');
    await fill('Password','new-demo-password');await press('Sign in');await expect(d.getByRole('button',{name:'Sign out',exact:true})).toBeVisible();
    await expect(d.locator('.ms-account-identity')).toContainText('demo@example.com');
    await d.getByRole('button',{name:'Home',exact:true}).click();await d.getByRole('button',{name:'Account',exact:true}).click();
    await expect(d.locator('.ms-account-identity')).toContainText('demo@example.com');
    expect(mutations).toEqual([]);expect(JSON.stringify(state.drafts)).toBe(before);
  });
  test(`native ${platform} auth screens fit Arabic compact and large previews`,async({page})=>{
    await setup(page);await ready(page);const d=page.getByTestId(`preview-${platform}`);
    await d.getByRole('button',{name:'Account',exact:true}).click();await accountSection(d, 'Home'); await d.getByRole('button',{name:'Sign out',exact:true}).click();
    await d.locator('.ms-phone').screenshot({path:`../output/mobile-native-account-20261012/${platform}-login.png`});
    await d.getByRole('button',{name:'Create account',exact:true}).click();
    await d.locator('.ms-phone').screenshot({path:`../output/mobile-native-account-20261012/${platform}-signup.png`});
    await d.getByRole('button',{name:'Back to sign in',exact:true}).click();await d.getByRole('button',{name:'Verify an existing account',exact:true}).click();
    await expect(d.getByRole('button',{name:'Send a new code',exact:true})).toBeDisabled();await d.getByRole('button',{name:'Back to sign in',exact:true}).click();
    await page.getByLabel('Preview language').selectOption('ar');await expect(page.getByLabel('Preview appearance')).toHaveCount(0);
    for(const width of ['320','390']) {
      await page.getByLabel('Device width').selectOption(width);await d.getByRole('button',{name:'نسيت كلمة المرور؟',exact:true}).click();
      await d.getByLabel('البريد أو الهاتف',{exact:true}).fill('preview@example.com');await d.getByRole('button',{name:'إرسال رمز إعادة التعيين',exact:true}).click();
      await expect(d.getByRole('heading',{name:'إعادة تعيين كلمة المرور',exact:true})).toBeVisible();
      await d.locator('.ms-phone').screenshot({path:`../output/mobile-native-account-20261012/${platform}-reset-ar-${width}.png`});
      expect(await d.locator('.ms-phone-content').evaluate(e=>e.scrollWidth<=e.clientWidth)).toBe(true);
      await d.getByRole('button',{name:'العودة لتسجيل الدخول',exact:true}).click();
    }
  });
}

test('sale exclusion and pending confirmation keep promos safe',async({page})=>{
  await setup(page);await ready(page);
  await page.route('**/app-preview/catalog?**',route=>route.fulfill({json:{merchantId:mid,locale:'en',source:'https://grocery.rocento.com',categories:[],products:[{id:'6d1bff50-62ba-40bc-baf2-c9ef685250d1',name:'Red grapes',price:'2.75',originalPrice:'4.00',currency:'USD',inStock:true,unit:'pack',imageUrl:null}]}}));await page.getByRole('button',{name:'Refresh catalog',exact:true}).click();const d=await openNativeBag(page);
  await d.getByLabel('Enter promo code').fill('FULLPRICE10');await d.getByRole('button',{name:'Apply code',exact:true}).click();await expect(d.getByRole('region',{name:'Promo codes and totals'}).getByRole('alert')).toContainText('excludes sale products');
  await d.getByLabel('Enter promo code').fill('SAVE10');await d.getByRole('button',{name:'Apply code',exact:true}).click();await saveNativeAddress(d);await d.getByText('Checkout preview settings',{exact:true}).click();await d.getByLabel('Test scenario',{exact:true}).selectOption('pending');await d.getByRole('button',{name:'Check availability',exact:true}).click();await d.getByRole('button',{name:'Review order',exact:true}).click();await d.getByRole('button',{name:'Place order',exact:true}).click();await expect(d.getByRole('button',{name:'Apply code',exact:true})).toBeDisabled();await expect(d.getByRole('button',{name:'Remove promo',exact:true})).toBeDisabled();await d.getByRole('button',{name:'Retry confirmation',exact:true}).click();await expect(d.getByRole('region',{name:'Order details'}).locator('.ms-checkout-total')).toContainText('$7.47');
});

test('signed-in preview verification keeps checkout and account status in sync',async({page})=>{
  await setup(page);await ready(page);const d=page.getByTestId('preview-iOS');
  await d.getByText('Checkout preview settings',{exact:true}).click();await d.getByLabel('Test scenario',{exact:true}).selectOption('verification');
  await d.getByRole('button',{name:'Account',exact:true}).click();await expect(d.locator('.ms-account-identity')).toContainText('Verification needed');
  await d.getByRole('button',{name:'Verify',exact:true}).click();await expect(d.getByRole('alert')).toContainText('Enter the verification code');
  await d.getByRole('button',{name:'Send verification code',exact:true}).click();await expect(d.getByRole('status')).toContainText('No message was sent');
  await d.getByLabel('Verification code',{exact:true}).fill('000000');await d.getByRole('button',{name:'Verify',exact:true}).click();
  await expect(d.locator('.ms-account-identity')).toContainText('Verified account');await expect(d.getByLabel('Test scenario',{exact:true})).toHaveValue('none');
});

test('admin icon choices persist with compatible runtimes and appear in release readiness', async ({ page }) => {
  const state = await setup(page);
  await ready(page);
  await page.getByRole('button', { name: 'Navigation', exact: true }).click();
  await page.getByLabel('home icon', { exact: true }).selectOption('location');
  await expect.poll(() => state.drafts.production.config.navigation.icons?.home).toBe('location');
  expect(state.drafts.production.config.compatibility).toEqual({ minIosRuntime: '1.1.0', minAndroidRuntime: '1.1.0' });
  await page.reload();
  await ready(page);
  await page.getByRole('button', { name: 'Navigation', exact: true }).click();
  await expect(page.getByLabel('home icon', { exact: true })).toHaveValue('location');
  await page.getByRole('button', { name: 'Release readiness', exact: true }).click();
  const report = page.getByLabel('Release readiness report');
  await expect(report.locator('dd').filter({ hasText: /^1\.1\.0$/ })).toHaveCount(2);
  await expect(report).toContainText('Local contract checks passed');
});

for (const platform of ['iOS', 'Android']) {
  test(`address design ${platform} saves and edits in compact Arabic mode`, async ({page}) => {
    await setup(page); await ready(page);
    await page.getByLabel('Device width').selectOption('320');
    const d=page.getByTestId('preview-'+platform);
    await d.getByRole('button',{name:'Account',exact:true}).click();
    await accountSection(d, 'Addresses'); await d.getByRole('button',{name:'Add delivery address',exact:true}).click();
    await fillPreviewAddress(d);
    await d.locator('.ms-native-address-dialog').screenshot({path:`../output/mobile-address-polish-20261012/${platform}-add.png`});
    await d.getByLabel('Delivery instructions',{exact:true}).fill('Please use the side entrance.');
    await d.getByRole('button',{name:'Save address',exact:true}).click();
    await accountSection(d, 'Addresses'); await d.getByText('Saved preview addresses',{exact:true}).click();
    await expect(d.locator('.ms-saved-address')).toHaveCount(1);
    await expect(d.locator('.ms-saved-address')).toContainText('Please use the side entrance.');
    await d.locator('.ms-address-book').screenshot({path:`../output/mobile-address-polish-20261012/${platform}-saved.png`});
    await page.getByLabel('Preview language').selectOption('ar');
    await expect(page.getByLabel('Preview appearance')).toHaveCount(0);
    await accountSection(d,'Addresses');await d.getByText('عناوين المعاينة المحفوظة',{exact:true}).click();
    await d.getByRole('button',{name:'تعديل العنوان',exact:true}).click();
    await expect(d.getByRole('heading',{name:'تعديل العنوان',exact:true})).toBeVisible();
    await d.getByLabel('الشارع والعنوان',{exact:true}).fill('١٨ شارع تجريبي، القاهرة');
    await d.locator('.ms-native-address-dialog').screenshot({path:`../output/mobile-address-polish-20261012/${platform}-edit-arabic.png`});
    const size=await d.locator('.ms-native-address-dialog').evaluate(el=>({w:el.clientWidth,s:el.scrollWidth}));
    expect(size.s).toBeLessThanOrEqual(size.w);
    await d.getByRole('button',{name:'حفظ العنوان',exact:true}).click();
    await expect(d.locator('.ms-saved-address')).toHaveCount(1);
    await expect(d.locator('.ms-saved-address')).toContainText('١٨ شارع تجريبي، القاهرة');
  });
}

for(const platform of ['iOS','Android']) {
  test(`native ${platform} category rows and product sheet dimensions follow the app`,async({page})=>{
    const state=await setup(page);await ready(page);const d=page.getByTestId(`preview-${platform}`),before=JSON.stringify(state.drafts);
    await d.getByRole('button',{name:'Categories',exact:true}).click();
    await expect(d.locator('.ms-category-art')).toHaveCount(0);
    await expect(d.locator('.ms-category-chevron')).toHaveCount(platform==='iOS'?1:0);
    await d.getByRole('button',{name:'Fresh fruit',exact:true}).click();
    await d.getByRole('button',{name:'View Red grapes',exact:true}).click();
    const imageSize=await d.locator('.ms-detail-image').boundingBox();
    if(platform==='iOS') expect(imageSize!.width/imageSize!.height).toBeCloseTo(1.22,1); else expect(Math.round(imageSize!.height)).toBe(288);
    await expect(d.getByRole('button',{name:'Add to cart',exact:true})).toHaveText('Add to cart');
    await expect(d.locator('.ms-sheet-toolbar')).toHaveCount(1);
    await expect(d.locator('.ms-native-product-done')).toHaveCount(0);
    await d.locator('.ms-phone').screenshot({path:`../output/mobile-native-products-20261012/${platform}-product.png`});
    await d.getByRole('button',{name:'Back',exact:true}).click();
    await expect(d.getByRole('button',{name:'View Red grapes',exact:true})).toBeFocused();
    await d.locator('.ms-phone').screenshot({path:`../output/mobile-native-products-20261012/${platform}-category.png`});
    await page.getByLabel('Preview language').selectOption('ar');await expect(page.getByLabel('Preview appearance')).toHaveCount(0);
    await d.getByRole('button',{name:'فواكه طازجة',exact:true}).click();
    for(const width of ['320','390']) {
      await page.getByLabel('Device width').selectOption(width);
      await d.getByRole('button',{name:'عرض عنب أحمر',exact:true}).click();
      await d.locator('.ms-phone').screenshot({path:`../output/mobile-native-products-20261012/${platform}-product-ar-${width}.png`});
      expect(await d.locator('.ms-sheet-content').evaluate(e=>e.scrollWidth<=e.clientWidth)).toBe(true);
      await page.keyboard.press('Escape');
    }
    expect(JSON.stringify(state.drafts)).toBe(before);
  });
}

test('native product description is plain catalog text and account exposes delivery addresses',async({page})=>{
  await setup(page);
  await page.route('**/app-preview/catalog?**',route=>route.fulfill({json:{merchantId:mid,locale:'en',source:'https://grocery.rocento.com',categories:[],products:[{id:'test-product',name:'Native product',description:'Fresh fruit. <b>Catalog text</b>',price:'2.75',currency:'USD',unit:'pack',inStock:true,imageUrl:null}]}}));
  await ready(page);const d=page.getByTestId('preview-iOS');await d.getByRole('button',{name:'View Native product',exact:true}).click();
  await expect(d.locator('.ms-detail-description')).toHaveText('Fresh fruit. <b>Catalog text</b>');await expect(d.locator('.ms-detail-description b')).toHaveCount(0);
  await d.getByRole('button',{name:'Back',exact:true}).click();await d.getByRole('button',{name:'Account',exact:true}).click();await d.getByRole('button',{name:/^Addresses/}).click();await expect(d.getByRole('dialog')).toHaveCount(0);await expect(d.getByRole('button',{name:'Add delivery address',exact:true})).toBeVisible();
});

for (const platform of ['iOS','Android']) {
  test(`notification settings ${platform} are independent and support compact Arabic`,async({page})=>{
    const state=await setup(page);await ready(page);
    const d=page.getByTestId(`preview-${platform}`), otherDevice=page.getByTestId(`preview-${platform==='iOS'?'Android':'iOS'}`);
    await d.getByRole('button',{name:'Account',exact:true}).click();
    await accountSection(d,'Home');await d.getByRole('button',{name:'Notifications',exact:true}).click();
    await expect(d.getByRole('heading',{name:'No updates yet'})).toBeVisible();
    await d.getByRole('button',{name:'My account',exact:false}).click();
    await d.getByRole('button',{name:'App settings',exact:true}).click();
    await d.getByRole('switch',{name:'Share anonymous usage analytics'}).check();
    await d.getByRole('switch',{name:'Show order updates'}).uncheck();
    await expect(d.getByLabel('Appearance',{exact:true})).toHaveCount(0); await expect(d.getByRole('radio',{name:'Dark',exact:true})).toHaveCount(0);
    await d.locator('.ms-phone').screenshot({path:`../output/mobile-preferences-20261012/${platform}-settings.png`});
    if(platform==='iOS') await d.getByLabel('App language',{exact:true}).selectOption('ar'); else await d.getByRole('group',{name:'App language',exact:true}).getByRole('button',{name:'العربية',exact:true}).click();
    await page.getByLabel('Device width').selectOption('320');
    await expect(d.getByRole('heading',{name:'إعدادات التطبيق',exact:true})).toBeVisible();
    expect(await d.locator('.ms-phone-content').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
    await d.locator('.ms-phone').screenshot({path:`../output/mobile-preferences-20261012/${platform}-settings-ar.png`});
    await otherDevice.getByRole('button',{name:'Account',exact:true}).click();
    await otherDevice.getByRole('button',{name:'App settings',exact:true}).click();
    await expect(otherDevice.getByRole('switch',{name:'Show order updates'})).toBeChecked();
    await expect(otherDevice.getByRole('switch',{name:'Share anonymous usage analytics'})).not.toBeChecked();
    await page.reload();await ready(page);
    await d.getByRole('button',{name:'Account',exact:true}).click();
    await accountSection(d,'Home');await d.getByRole('button',{name:'Notifications',exact:true}).click();
    await expect(d.getByRole('heading',{name:'Order updates are paused'})).toBeVisible();
    await d.getByRole('button',{name:'Notification settings',exact:true}).click();
    await expect(d.getByRole('switch',{name:'Share anonymous usage analytics'})).toBeChecked();
    await expect(d.getByLabel('Appearance',{exact:true})).toHaveCount(0); await expect(d.getByRole('radio',{name:'Dark',exact:true})).toHaveCount(0);
    await d.getByRole('switch',{name:'Show order updates'}).check();
    expect(state.writes).toBe(0);
  });
  test(`notification inbox ${platform} links order updates and persists read state`,async({page})=>{
    const state=await setup(page);await ready(page);const d=await openNativeBag(page,platform);
    await saveNativeAddress(d);
    await d.getByRole('button',{name:'Check availability',exact:true}).click();
    await d.getByRole('button',{name:'Review order',exact:true}).click();
    await d.getByRole('button',{name:'Place order',exact:true}).click();
    await d.getByRole('button',{name:'Account',exact:true}).click();
    await accountSection(d,'Home');await d.getByRole('button',{name:'Notifications',exact:true}).click();
    await expect(d.locator('.ms-notification-card')).toHaveCount(1);
    await d.getByRole('button',{name:'Refresh updates',exact:true}).click();
    await expect(d.getByRole('status')).toContainText('Updates refreshed');
    await expect(d.locator('.ms-notification-card')).toHaveCount(1);
    await expect(d.locator('.ms-notification-card')).toHaveCSS('border-radius','0px');
    await d.locator('.ms-phone').screenshot({path:`../output/mobile-preferences-20261012/${platform}-inbox.png`});
    await d.locator('.ms-notification-card').click();
    await expect(d.getByRole('region',{name:'Order details'})).toBeVisible();
    await orderPreviewAction(d,'Simulate next status');
    await accountSection(d,'Home');await d.getByRole('button',{name:'Notifications',exact:true}).click();
    await expect(d.locator('.ms-notification-card')).toHaveCount(2);
    await d.getByRole('button',{name:'Unread (1)',exact:true}).click();
    await expect(d.locator('.ms-notification-card')).toHaveCount(1);
    await d.getByRole('button',{name:'Mark all read',exact:true}).click();
    await expect(d.getByRole('heading',{name:'You’re all caught up'})).toBeVisible();
    await page.reload();await ready(page);
    await d.getByRole('button',{name:'Account',exact:true}).click();await accountSection(d,'Home');await d.getByRole('button',{name:'Notifications',exact:true}).click();
    await expect(d.getByRole('button',{name:'Unread (0)',exact:true})).toBeVisible();
    expect(state.writes).toBe(0);
  });
}

for (const platform of ['iOS', 'Android']) test(`${platform} category filters remain scoped through reset and product navigation`, async ({ page }) => {
  await setup(page); await ready(page);
  const phone = page.getByTestId(`preview-${platform}`);
  await phone.getByRole('button', { name: 'Categories', exact: true }).click();
  await phone.getByRole('button', { name: 'Fresh fruit', exact: true }).click();
  await expect(phone.getByRole('button', { name: 'Fresh fruit', exact: true })).toHaveAttribute('aria-pressed','true');
  await expect(phone.getByRole('heading', { name: 'Fresh fruit' })).toBeVisible();
  await phone.getByText('Filter & sort', { exact: true }).click();
  await openFilterSheet(phone); await phone.getByLabel('Min price', { exact: true }).fill('3');
  await phone.getByLabel('Max price', { exact: true }).fill('2');
  await expect(phone.getByRole('button', { name: 'Show results' })).toBeDisabled();
  await phone.getByLabel('Max price', { exact: true }).fill('10');
  await phone.getByLabel('In stock only').check();
  await phone.getByLabel('Sort by').selectOption('price_desc');
  const applied = page.waitForRequest(r => { const u = new URL(r.url()); return u.pathname.endsWith('/app-preview/catalog') && u.searchParams.get('min_price') === '3'; });
  await phone.getByRole('button', { name: 'Show results' }).click();
  const query = new URL((await applied).url()).searchParams;
  expect(query.get('collection')).toBe('7edd7367-5330-47c4-8fa9-73c18f23ea67');
  expect(query.get('sort')).toBe('price_desc'); expect(query.get('in_stock')).toBe('true');
  await phone.getByRole('button', { name: 'View Red grapes' }).click();
  await phone.getByRole('button', { name: 'Back', exact: true }).click();
  await openFilterSheet(phone); await expect(phone.getByLabel('Min price', { exact: true })).toHaveValue('3');
  const reset = page.waitForRequest(r => { const u = new URL(r.url()); return u.pathname.endsWith('/app-preview/catalog') && u.searchParams.has('collection') && u.searchParams.has('q') && !u.searchParams.has('min_price'); });
  await phone.getByRole('button', { name: 'Reset', exact: true }).click(); await phone.getByRole('button', { name: 'Show results', exact: true }).click();
  expect(new URL((await reset).url()).searchParams.get('collection')).toBe('7edd7367-5330-47c4-8fa9-73c18f23ea67');
  await phone.getByRole('button', { name: 'Back' }).click();
  await expect(phone.getByRole('button', { name: 'Fresh fruit', exact: true })).toBeVisible();
});

test('category attribute filters and pagination use storefront semantics', async ({ page }) => {
  await setup(page);
  const requests: URLSearchParams[] = [];
  await page.route('**/app-preview/catalog?**', route => {
    const params = new URL(route.request().url()).searchParams;
    const filtered = params.has('attribute_filters'), offset = Number(params.get('offset') || 0);
    if (params.has('q')) requests.push(params);
    return route.fulfill({ json: { merchantId: mid, locale: 'en', source: 'https://grocery.rocento.com',
      categories: [{ id: '7edd7367-5330-47c4-8fa9-73c18f23ea67', slug: 'featured', name: 'Fresh fruit', imageUrl: null }],
      products: [{ id: String(offset), name: offset ? 'Second product' : 'First product', price: '5', originalPrice: null, currency: 'USD', unit: 'each', inStock: true, imageUrl: null }], total: filtered ? 1 : 25, nextOffset: filtered || offset ? null : 24,
      attributes: [{ attribute_code: 'organic', label: 'Organic', input_type: 'boolean', is_filterable: true, is_visible_on_front: true, options: [], metadata: { facetable: true } }], facets: { organic: { true: 10, false: 15 } },
    } });
  });
  await ready(page); const phone = page.getByTestId('preview-iOS');
  await phone.getByRole('button', { name: 'Categories', exact: true }).click();
  await phone.getByRole('button', { name: 'Fresh fruit', exact: true }).click();
  await phone.getByRole('button', { name: 'Load more products' }).click();
  await expect(phone.getByRole('button', { name: 'View Second product' })).toBeVisible();
  expect(requests.at(-1)?.get('offset')).toBe('24');
  await phone.getByText('Filter & sort', { exact: true }).click();
  await phone.getByText('Organic', { exact: true }).click();
  await phone.getByRole('switch', { name: 'Yes', exact: true }).check();
  await phone.getByRole('button', { name: 'Show results' }).click();
  await expect(phone.getByRole('button', { name: 'View Second product' })).toHaveCount(0);
  await expect.poll(() => requests.at(-1)?.get('attribute_filters')).toBe('{"organic":[true]}');
  expect(requests.at(-1)?.get('offset')).toBe('0');
  expect(requests.at(-1)?.get('collection')).toBe('7edd7367-5330-47c4-8fa9-73c18f23ea67');
  await phone.screenshot({ path: '/tmp/mobile-category-filters.png' });
});

for(const platform of ['iOS','Android']) test(`support screens ${platform} search validate and fit Arabic mode`,async({page})=>{
 const state=await setup(page);await ready(page);const d=page.getByTestId(`preview-${platform}`);
 const mutations:string[]=[];page.on('request',r=>{if(!['GET','HEAD','OPTIONS'].includes(r.method()))mutations.push(r.url());});
 await d.getByRole('button',{name:'Account',exact:true}).click();await d.getByRole('button',{name:'Help & support',exact:true}).click();
 await d.getByLabel('Search help',{exact:true}).fill('cancel');await expect(d.locator('.ms-support-faq details')).toHaveCount(1);
 await d.getByText('Can I cancel an order?',{exact:true}).click();await expect(d.locator('.ms-support-faq p')).toBeVisible();
 await d.getByLabel('Search help',{exact:true}).fill('zzzzz');await expect(d.getByRole('heading',{name:'No matching answers'})).toBeVisible();await d.getByRole('button',{name:'Clear search',exact:true}).click();await expect(d.locator('.ms-support-faq details')).toHaveCount(5);
 await d.locator('.ms-phone').screenshot({path:`../output/mobile-support-20261012/${platform}-help.png`});
 await d.getByRole('button',{name:'Contact us',exact:true}).click();
 await d.getByRole('button',{name:'Preview message',exact:true}).click();await expect(d.getByRole('heading',{name:'Preview message complete'})).toHaveCount(0);
 await d.getByLabel('Your name',{exact:true}).fill('Preview customer');await d.getByLabel('Email address',{exact:true}).fill('preview@example.com');await d.getByLabel('Topic',{exact:true}).selectOption('delivery');await d.getByLabel('Message',{exact:true}).fill('A preview delivery question for testing.');
 await d.getByRole('button',{name:'Preview message',exact:true}).click();await expect(d.getByRole('status')).toContainText('no message was sent');await d.getByRole('button',{name:'Start another message'}).click();
 await page.getByLabel('Device width').selectOption('320');await page.getByLabel('Preview language').selectOption('ar');await expect(page.getByLabel('Preview appearance')).toHaveCount(0);
 await expect(d.getByRole('heading',{name:'نحن هنا لمساعدتك'})).toBeVisible();expect(await d.locator('.ms-phone-content').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
 await d.locator('.ms-phone').screenshot({path:`../output/mobile-support-20261012/${platform}-contact-ar.png`});
 await d.getByRole('button',{name:'حسابي',exact:false}).click();await d.getByRole('button',{name:'المساعدة والدعم',exact:true}).click();await d.getByLabel('البحث في المساعدة',{exact:true}).fill('إلغاء');await expect(d.locator('.ms-support-faq details')).toHaveCount(1);
 expect(state.writes).toBe(0);expect(mutations).toEqual([]);
});

for (const platform of ['iOS', 'Android']) test(`native search ${platform} controls validate and fit Arabic mode`, async ({ page }) => {
  const state = await setup(page); await ready(page);
  const phone = page.getByTestId(`preview-${platform}`);
  await phone.getByRole('button', { name: 'Categories', exact: true }).click();
  await phone.getByRole('button', { name: 'Fresh fruit', exact: true }).click();
  await expect(phone.getByLabel('Min price')).toBeHidden();
  await phone.getByText('Filter & sort', { exact: true }).click();
  await expect(phone.getByRole(platform === 'iOS' ? 'switch' : 'checkbox', { name: 'In stock only' })).toBeVisible();
  await openFilterSheet(phone); await phone.getByLabel('Min price').fill('-1');
  await expect(phone.getByRole('button', { name: 'Show results' })).toBeDisabled();
  await expect(phone.getByRole('alert')).toContainText('Enter a valid price range.');
  await phone.getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(phone.getByRole('button', { name: 'Show results' })).toBeEnabled();
  await phone.locator('.ms-phone-content').evaluate(e => { e.scrollTop = 0; });
  await phone.locator('.ms-phone').screenshot({ path: `../output/mobile-native-search-20261012/${platform}-filters.png` });
  await page.getByLabel('Preview language').selectOption('ar');
  await expect(page.getByLabel('Preview appearance')).toHaveCount(0);
  await page.getByLabel('Device width').selectOption('320');
  await phone.getByRole('button', { name: 'فواكه طازجة', exact: true }).click();
  await phone.getByText('تصفية وترتيب', { exact: true }).click();
  await phone.getByLabel('أقل سعر').fill('2');
  await phone.getByRole(platform === 'iOS' ? 'switch' : 'checkbox', { name: 'المتوفر فقط' }).check();
  await phone.locator('.ms-phone-content').evaluate(e => { e.scrollTop = 0; });
  await phone.locator('.ms-phone').screenshot({ path: `../output/mobile-native-search-20261012/${platform}-filters-ar.png` });
  expect(await phone.locator('.ms-phone-content').evaluate(e => e.scrollWidth <= e.clientWidth)).toBe(true);
  expect(state.writes).toBe(0);
});

for(const platform of ['iOS','Android']) test(`information screens ${platform} navigate documents and support Arabic`,async({page})=>{
 const state=await setup(page);await ready(page);const d=page.getByTestId(`preview-${platform}`);const mutations:string[]=[];page.on('request',r=>{if(!['GET','HEAD','OPTIONS'].includes(r.method()))mutations.push(r.url());});
 await d.getByRole('button',{name:'Account',exact:true}).click();await d.getByRole('button',{name:'About us',exact:true}).click();await expect(d.getByRole('heading',{name:'Shopping, at your fingertips'})).toBeVisible();
 await d.locator('.ms-phone').screenshot({path:`../output/mobile-information-20261012/${platform}-about.png`});
 await d.getByRole('button',{name:'Privacy policy',exact:true}).click();await expect(d.getByRole('note')).toContainText('not an official policy');
 await d.getByRole('navigation',{name:'On this page'}).getByRole('button',{name:'Storage and retention'}).click();await expect(d.locator('.ms-information-document section').nth(2)).toBeFocused();
 await d.getByRole('button',{name:'Terms & conditions',exact:true}).click();await expect(d.locator('.ms-information-document section')).toHaveCount(5);
 await page.getByLabel('Device width').selectOption('320');await page.getByLabel('Preview language').selectOption('ar');await expect(page.getByLabel('Preview appearance')).toHaveCount(0);await expect(d.getByRole('heading',{name:'الشروط والأحكام',exact:true})).toBeVisible();
 expect(await d.locator('.ms-phone-content').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);await d.locator('.ms-phone').screenshot({path:`../output/mobile-information-20261012/${platform}-terms-ar.png`});
 await d.getByRole('button',{name:'سياسة الخصوصية',exact:true}).click();await expect(d.getByRole('note')).toContainText('ليست سياسة');await d.getByRole('button',{name:'تواصل معنا',exact:true}).click();await expect(d.getByRole('heading',{name:'نحن هنا لمساعدتك'})).toBeVisible();
 await d.getByRole('button',{name:'حسابي',exact:false}).click();await d.getByRole('button',{name:'تسجيل الخروج',exact:true}).click();await d.getByRole('button',{name:'من نحن',exact:true}).click();await expect(d.getByRole('heading',{name:'من نحن',exact:true})).toBeVisible();
 expect(state.writes).toBe(0);expect(mutations).toEqual([]);
});

for (const platform of ['iOS','Android']) test(`native wishlist ${platform} saves opens removes and fits Arabic`,async({page})=>{
  const state=await setup(page);await ready(page);const d=page.getByTestId(`preview-${platform}`);
  await d.getByRole('button',{name:'Account',exact:true}).click();await d.getByRole('button',{name:/^Wishlist/}).click();
  await expect(d.getByText('Your wishlist is empty. Save a product from its details.',{exact:true})).toBeVisible();
  await d.getByRole('button',{name:'Explore products',exact:true}).click();
  await d.getByRole('button',{name:'Fresh fruit',exact:true}).click();await d.getByRole('button',{name:'View Red grapes',exact:true}).click();
  await d.getByRole('button',{name:'Save to wishlist',exact:true}).click();await d.getByRole('button',{name:'Back',exact:true}).click();
  await d.getByRole('button',{name:'Account',exact:true}).click();await d.getByRole('button',{name:/^Wishlist/}).click();
  await expect(d.getByRole('article',{name:'Red grapes'})).toBeVisible();await expect(d.getByText('2.75 USD',{exact:true})).toBeVisible();
  expect(await d.locator('.ms-wishlist-image').evaluate(e=>e.getBoundingClientRect().width)).toBe(80);
  await d.getByRole('button',{name:'View product',exact:true}).click();await expect(d.getByRole('dialog')).toBeVisible();await d.getByRole('button',{name:'Back',exact:true}).click();
  await d.locator('.ms-phone').screenshot({path:`../output/mobile-native-wishlist-20261012/${platform}-saved.png`});
  await page.getByLabel('Preview language').selectOption('ar');await expect(page.getByLabel('Preview appearance')).toHaveCount(0);await page.getByLabel('Device width').selectOption('320');
  await expect(d.getByRole('heading',{name:'المنتجات المحفوظة'})).toBeVisible();
  expect(await d.locator('.ms-phone-content').evaluate(e=>e.scrollWidth<=e.clientWidth)).toBe(true);
  await d.locator('.ms-phone').screenshot({path:`../output/mobile-native-wishlist-20261012/${platform}-saved-ar.png`});
  await d.getByRole('button',{name:'إزالة من المفضلة',exact:true}).click();await expect(d.getByRole('article')).toHaveCount(0);
  expect(state.writes).toBe(0);
});

for(const platform of ['iOS','Android']) test(`matched order history ${platform} refresh preserves status and supports Arabic`,async({page})=>{
 const state=await setup(page);await ready(page);const d=await openNativeBag(page,platform);await saveNativeAddress(d);
 await d.getByRole('button',{name:'Check availability',exact:true}).click();await d.getByRole('button',{name:'Review order',exact:true}).click();await d.getByRole('button',{name:'Place order',exact:true}).click();
 await d.getByRole('button',{name:'Account',exact:true}).click();await accountSection(d, 'Orders'); await d.locator('.ms-native-order-link').click();
 await expect(d.locator('.ms-history-thumbnail')).toHaveCount(0);
 await expect(d.locator('.ms-native-order-link')).toHaveCSS('border-top-width','0px');
 await expect(d.locator('.ms-native-order-link')).toHaveCSS('border-radius','0px');
 await expect(d.locator('.ms-native-order-history li')).toHaveCount(1);
 await expect(d.getByRole('button',{name:'Simulate next status',exact:true})).toBeHidden();
 await d.getByRole('button',{name:'Refresh status',exact:true}).click();
 await expect(d.locator('.ms-native-order-status')).toHaveText('Order placed');await expect(d.locator('.ms-native-order-history li')).toHaveCount(1);
 await orderPreviewAction(d,'Simulate next status');await expect(d.locator('.ms-native-order-history li')).toHaveCount(2);
 await d.locator('.ms-order-preview-tools > summary').click();
 await d.locator('.ms-native-order-link').scrollIntoViewIfNeeded();
 await d.locator('.ms-phone').screenshot({path:`../output/mobile-native-orders-20261012/${platform}-history.png`});
 await page.getByLabel('Preview language').selectOption('ar');await expect(page.getByLabel('Preview appearance')).toHaveCount(0);await page.getByLabel('Device width').selectOption('320');
 await accountSection(d, 'Orders'); await d.locator('.ms-native-order-link').click();await expect(d.locator('.ms-native-order-status')).toHaveText('تم تأكيد الطلب');
 await expect(d.getByRole('button',{name:'تحديث الحالة',exact:true})).toBeVisible();
 expect(await d.locator('.ms-phone-content').evaluate(e=>e.scrollWidth<=e.clientWidth)).toBe(true);
 await d.locator('.ms-phone').screenshot({path:`../output/mobile-native-orders-20261012/${platform}-tracking-ar.png`});
 expect(state.writes).toBe(0);
});

test('theme shape presets save native tokens without a preview on settings pages', async ({ page }) => {
  const state = await setup(page);
  await ready(page);
  await page.getByRole('radio', { name: 'Square 0 px', exact: true }).check();
  await expect.poll(() => state.drafts.production.config.brand.radiusToken).toBe('none');
  await page.getByRole('radio', { name: 'Extra rounded 28 px', exact: true }).check();
  await page.getByRole('radio', { name: 'Compact 12 px · more content', exact: true }).check();
  await expect.poll(() => state.drafts.production.config.brand.radiusToken).toBe('large');
  await expect.poll(() => state.drafts.production.config.brand.density).toBe('compact');
  await expect(page.locator('.ms-preview-area')).toBeHidden();
  await page.reload();
  await expect(page.getByRole('radio', { name: 'Extra rounded 28 px', exact: true })).toBeChecked();
});

for (const platform of ['iOS','Android']) test(`native header and Deals ${platform} support search, saved locations and compact RTL`,async({page})=>{
  const state=await setup(page);await ready(page);
  for(const env of ['staging','production'] as const){state.drafts[env].config.navigation.tabs=['home','categories','deals','account','cart'];state.drafts[env].config.compatibility.minIosRuntime='1.2.0';state.drafts[env].config.compatibility.minAndroidRuntime='1.2.0';}
  await page.reload();await ready(page);
  await page.route('**/app-preview/catalog?**',route=>{const u=new URL(route.request().url());if(!u.searchParams.has('q'))return route.fallback();const offset=Number(u.searchParams.get('offset'));return route.fulfill({json:{merchantId:mid,locale:u.searchParams.get('locale'),source:'https://grocery.rocento.com',categories:[],products:offset?[{id:'deal',name:'Discounted apple',price:'2',originalPrice:'3',currency:'USD',unit:'each',inStock:true,imageUrl:null}]:[{id:'regular',name:'Regular apple',price:'3',originalPrice:null,currency:'USD',unit:'each',inStock:true,imageUrl:null}],nextOffset:offset?null:24,total:25}})});
  const d=page.getByTestId(`preview-${platform}`);
  await expect(d.locator('.ms-native-brand')).toHaveCount(0);
  await expect(d.getByRole('button',{name:'Choose delivery location',exact:true})).toBeVisible();
  if(platform==='Android'){await expect(d.locator('.ms-native-header-search')).toHaveCSS('border-top-width','1px');await expect(d.locator('.ms-native-header-search')).toHaveCSS('min-height','56px');await expect(d.locator('.ms-tab-icon svg[data-icon=categories]')).toHaveAttribute('fill','none');await expect(d.locator('.ms-tab-icon svg[data-icon=deals]')).toHaveAttribute('stroke-width','1.7');}
  await d.getByRole('button',{name:'Shopping assistant',exact:true}).click(); await expect(d.getByRole('heading',{name:'Find something you’ll love'})).toBeVisible(); await d.getByRole('button',{name:'Done',exact:true}).click();
  await expect(d.getByRole('navigation').getByRole('button')).toHaveText(['Home','Categories','Deals','Account','Cart']);
  await d.getByLabel('Header search',{exact:true}).fill('apple');await d.getByLabel('Header search',{exact:true}).press('Enter');
  await openFilterSheet(d); await expect(d.getByLabel('Search products',{exact:true})).toHaveValue('apple');await d.getByRole('button',{name:'Done',exact:true}).click();
  await d.getByRole('button',{name:'Deals',exact:true}).click();await expect(d.getByText('No offers in these products. Explore more below.')).toBeVisible();
  await d.getByRole('button',{name:'Explore more deals',exact:true}).click();
  await expect(d.getByRole('button',{name:'View Discounted apple',exact:true})).toBeVisible();
  await expect(d.getByRole('button',{name:'View Regular apple',exact:true})).toHaveCount(0);
  await d.getByLabel('Choose delivery location',{exact:true}).click();
  await fillPreviewAddress(d); await d.getByRole('button',{name:'Save address',exact:true}).click();
  await d.getByRole('button',{name:'Home',exact:true}).click();await expect(d.locator('.ms-native-location-trigger strong')).not.toHaveText('Choose location');
  await page.getByLabel('Device width').selectOption('320');await page.getByLabel('Preview language').selectOption('ar');
  expect(await d.locator('.ms-native-header-row').evaluate(el=>el.scrollWidth<=el.clientWidth)).toBe(true);
  await d.locator('.ms-phone').screenshot({path:`../output/mobile-native-preferences-20261012/${platform}-header-rtl.png`});
  expect(state.writes).toBe(0);
});

async function openFilterSheet(phone: ReturnType<Page['getByTestId']>) { if (!(await phone.getByRole('dialog').isVisible())) await phone.getByRole('button', {name: /Filter & sort|تصفية وترتيب/, exact:true}).click(); }

async function accountSection(device: import('@playwright/test').Locator, section: 'Addresses'|'Orders'|'Home') {
  const back = device.getByRole('button', {name:/^(‹ My account|حسابي ›)$/});
  const target = section === 'Home' ? null : device.locator('.ms-account-shortcuts').getByRole('button',{name:new RegExp(section === 'Orders' ? '^(Orders|الطلبات)' : '^(Addresses|العناوين)')});
  if (section === 'Home') { if(await back.isVisible()) await back.click(); return; }
  if (await target!.isVisible()) await target!.click();
}

test('product action visibility switches persist independently', async ({page}) => {
  const state=await setup(page); await ready(page);
  await page.getByRole('button', {name:'Features', exact:true}).click();
  await page.getByLabel('Show wishlist icon on products').uncheck();
  await page.getByLabel('Show compare icon on products').uncheck();
  await expect.poll(()=>state.drafts.production.config.screens.product).toEqual({showWishlist:false,showCompare:false});
  await page.getByLabel('Show wishlist icon on products').check();
  await expect.poll(()=>state.drafts.production.config.screens.product).toEqual({showWishlist:true,showCompare:false});
  await page.reload();
  await ready(page);
  await page.getByRole('button', {name:'Features', exact:true}).click();
  await expect(page.getByLabel('Show wishlist icon on products')).toBeChecked();
  await expect(page.getByLabel('Show compare icon on products')).not.toBeChecked();
});

test('grocery banner demos support tall carousels and horizontal layouts', async ({ page }) => {
  const state = await setup(page);
  await ready(page);
  const art = ['produce', 'pantry', 'greens', 'breakfast'];
  const uploaded: string[] = [];
  await page.route('**/api/v1/merchants/*/assets?*', async route => {
    if(route.request().method() !== 'POST') return route.fallback();
    const name = art[uploaded.length];
    const id = `d3d03c49-c514-40fc-b251-cc6bf3b7190${uploaded.length + 1}`;
    uploaded.push(name);
    return route.fulfill({ contentType: 'application/json', status:201, body:JSON.stringify({id,name,kind:'image',verified:true,url:null,width:640,height:960,sizeBytes:320000,contentType:'image/png',checksum:'b'.repeat(64)}) });
  });
  await page.route('**/api/v1/merchants/*/assets/d3d03c49-*/content', async route => {
    const index = Number(new URL(route.request().url()).pathname.split('/').at(-2)!.at(-1)) - 1;
    return route.fulfill({contentType:'image/png',body:readFileSync(new URL(`../../apps/mobile-studio/public/demo-banners/${art[index]}.png`,import.meta.url))});
  });
  await page.getByRole('button',{name:'Sections',exact:true}).click();
  await page.getByRole('button',{name:'Component library',exact:true}).click();
  await page.getByRole('button',{name:'Add grocery banner demos',exact:true}).click();
  await expect(page.getByLabel('Banner layout',{exact:true})).toHaveValue('portrait');
  await expect.poll(()=>state.drafts.production.config.compatibility.minIosRuntime).toBe('1.3.0');
  await expect.poll(()=>state.drafts.production.config.screens.home.sections.at(-2)?.props).toMatchObject({layout:'portrait',additionalImageAssetIds:['d3d03c49-c514-40fc-b251-cc6bf3b71902','d3d03c49-c514-40fc-b251-cc6bf3b71903']});
  await page.getByLabel('Banner layout',{exact:true}).selectOption('horizontal');
  await page.getByLabel('Image fitting',{exact:true}).selectOption('contain');
  await expect.poll(()=>state.drafts.production.config.screens.home.sections.at(-2)?.props).toMatchObject({layout:'horizontal',imageFit:'contain'});
  expect(uploaded).toEqual(art);
});

test('native preview sidebar preserves the running session across design panels', async ({ page }) => {
  await setup(page);
  await ready(page);
  let starts = 0;
  const expiresAt = new Date(Date.now() + 1800000).toISOString();
  await page.route('**/app-preview/sessions/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/worker')) {
      starts++;
      return route.fulfill({ json: { id: 'sidebar-preview', expiresAt } });
    }
    if (route.request().method() === 'DELETE') return route.fulfill({ json: { ok: true } });
    if (path.endsWith('/sidebar-preview')) return route.fulfill({ json: { expiresAt, appliedRevision: 1, appliedAt: new Date().toISOString() } });
    return route.fulfill({ status: 503, body: '' });
  });
  const sidebar = page.getByRole('navigation', { name: 'Studio tools' });
  const preview = sidebar.getByRole('button', { name: 'Native Preview' });
  await preview.click();
  await expect(preview).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { name: 'Native Preview', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open iOS Preview', exact: true }).click();
  const canvas = page.locator('.ms-preview-area canvas');
  await expect(canvas).toBeVisible();
  await canvas.evaluate(el => el.setAttribute('data-sidebar-retained', 'true'));
  await expect(preview.getByRole('img', { name: 'Preview session active' })).toBeVisible();
  await sidebar.getByRole('button', { name: 'Brand & theme', exact: true }).click();
  await expect(page.getByLabel('App display name')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop native preview' })).toBeHidden();
  await expect(canvas).toBeHidden();
  await expect(canvas).toHaveAttribute('data-sidebar-retained', 'true');
  for (const name of ['Sections', 'Navigation', 'Features', 'Languages', 'Assets', 'Release history', 'Test installations']) {
    await sidebar.getByRole('button', { name, exact: true }).click();
    await expect(canvas).toBeHidden();
    await expect(canvas).toHaveAttribute('data-sidebar-retained', 'true');
  }
  await preview.click();
  await expect(canvas).toBeVisible();
  await expect(canvas).toHaveAttribute('data-sidebar-retained', 'true');
  expect(starts).toBe(1);
  await page.getByRole('button', { name: 'Stop native preview' }).click();
  await expect(canvas).toHaveCount(0);
  await expect(preview.getByRole('img', { name: 'Preview session active' })).toHaveCount(0);
});

test('brand theme saves native-supported values without changing hidden platform settings', async ({ page }, testInfo) => {
  const state = await setup(page);
  await ready(page);
  const panel = page.locator('.ms-brand-theme');
  const original = structuredClone(state.drafts.production.config);
  await expect(panel).toBeVisible();
  await expect(panel.getByText('Native storefronts currently use the light palette.', { exact: false })).toBeVisible();
  for (const label of ['Button text', 'Page text', 'Card text']) {
    await expect(panel.getByText(label, { exact: true })).toBeVisible();
  }
  await expect(panel.getByText('Pass', { exact: true })).toHaveCount(3);

  await panel.getByLabel('App display name', { exact: true }).fill('Market Atelier');
  await panel.getByLabel('Brand color (primary hex)', { exact: true }).fill('#B45134');
  await panel.getByLabel('Page background (background hex)', { exact: true }).fill('#FFF9F5');
  await panel.getByRole('radio', { name: 'Extra rounded 28 px', exact: true }).check();
  await panel.getByRole('radio', { name: 'Compact 12 px · more content', exact: true }).check();
  await expect.poll(() => state.drafts.production.config.brand).toMatchObject({
    displayName: 'Market Atelier',
    light: { primary: '#B45134', background: '#FFF9F5' },
    radiusToken: 'large',
    density: 'compact',
  });
  expect(state.drafts.production.config.brand.dark).toEqual(original.brand.dark);
  expect(state.drafts.production.config.brand.fontToken).toBe(original.brand.fontToken);
  expect(state.drafts.production.config.compatibility).toEqual(original.compatibility);
  await expect(panel.locator('.ms-component-sample')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Native simulator preview', includeHidden: true })).toBeHidden();

  await page.reload();
  await ready(page);
  await expect(panel.getByLabel('App display name', { exact: true })).toHaveValue('Market Atelier');
  await expect(panel.getByLabel('Brand color (primary hex)', { exact: true })).toHaveValue('#B45134');
  await expect(panel.getByLabel('Page background (background hex)', { exact: true })).toHaveValue('#FFF9F5');
  await expect(panel.getByRole('radio', { name: 'Extra rounded 28 px', exact: true })).toBeChecked();
  await expect(panel.getByRole('radio', { name: 'Compact 12 px · more content', exact: true })).toBeChecked();
  await page.screenshot({ path: testInfo.outputPath('brand-theme-desktop.png'), fullPage: true });
});

test('brand theme blocks invalid hex and insufficient contrast until corrected', async ({ page }) => {
  const state = await setup(page);
  await ready(page);
  const panel = page.locator('.ms-brand-theme');
  const primary = panel.getByLabel('Brand color (primary hex)', { exact: true });
  await primary.fill('#123');
  await expect(panel.getByText('Use a six-digit hex color, such as #B45134.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save draft', exact: true })).toBeDisabled();
  // Allow the autosave debounce to elapse so this checks that invalid values never write.
  await page.waitForTimeout(1100);
  expect(state.writes).toBe(0);

  await primary.fill(fixture.brand.light.primary);
  await panel.getByLabel('On-brand text (onPrimary hex)', { exact: true }).fill(fixture.brand.light.primary);
  await expect(panel.getByText('Needs contrast', { exact: true })).toHaveCount(1);
  await expect(panel.getByText('Pass', { exact: true })).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Save draft', exact: true })).toBeDisabled();
  await page.waitForTimeout(1100);
  expect(state.writes).toBe(0);

  await panel.getByLabel('On-brand text (onPrimary hex)', { exact: true }).fill(fixture.brand.light.onPrimary);
  await primary.fill('#B45134');
  await expect(panel.getByText('Needs contrast', { exact: true })).toHaveCount(0);
  await expect(panel.getByText('Pass', { exact: true })).toHaveCount(3);
  await expect.poll(() => state.drafts.production.config.brand.light.primary).toBe('#B45134');
  expect(state.drafts.production.config.brand.light.onPrimary).toBe(fixture.brand.light.onPrimary);
});

test('brand theme keeps operator controls read-only', async ({ page }) => {
  const state = await setup(page, 'operator');
  await ready(page);
  const panel = page.locator('.ms-brand-theme');
  const controls = panel.locator('input, select, textarea');
  expect(await controls.count()).toBeGreaterThan(10);
  for (const control of await controls.all()) await expect(control).toBeDisabled();
  await expect(panel.getByText('Pass', { exact: true })).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Save draft', exact: true })).toBeDisabled();
  await page.waitForTimeout(1100);
  expect(state.writes).toBe(0);
});

test('brand theme fits a mobile viewport and exposes keyboard-accessible color controls', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await ready(page);
  const panel = page.locator('.ms-brand-theme');
  await expect(panel).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect.poll(() => panel.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  const picker = panel.getByLabel('Brand color (primary picker)', { exact: true });
  await expect(picker).toHaveAttribute('type', 'color');
  await picker.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(picker).toBeFocused();
  await expect(picker).not.toHaveCSS('outline-style', 'none');
  await page.screenshot({ path: testInfo.outputPath('brand-theme-mobile-390.png'), fullPage: true });
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect.poll(() => panel.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await expect(page.locator('.ms-preview-area')).toBeHidden();
  }
});

test('release readiness reports saved validation and preserves newer runtimes through navigation edits', async ({ page }) => {
  const state = await setup(page);
  state.drafts.production.config.compatibility = { minIosRuntime: '1.3.0', minAndroidRuntime: '1.2.0' };
  await ready(page);
  await page.getByRole('button', { name: 'Release readiness', exact: true }).click();
  const report = page.getByLabel('Release readiness report');
  await expect(report).toContainText('Draft saved');
  await expect(report).toContainText('Backend validation required');
  await page.getByRole('button', { name: 'Validate draft', exact: true }).click();
  await expect(report).toContainText('Current draft validated by the backend');
  await page.getByRole('button', { name: 'Navigation', exact: true }).click();
  await page.getByLabel('home icon', { exact: true }).selectOption('location');
  await expect.poll(() => state.drafts.production.config.navigation.icons?.home).toBe('location');
  expect(state.drafts.production.config.compatibility).toEqual({ minIosRuntime: '1.3.0', minAndroidRuntime: '1.2.0' });
  await page.getByRole('button', { name: 'Add deals tab', exact: true }).click();
  await expect.poll(() => state.drafts.production.config.navigation.tabs.includes('deals')).toBe(true);
  expect(state.drafts.production.config.compatibility.minIosRuntime).toBe('1.3.0');
  await page.getByLabel('deals icon', { exact: true }).selectOption('location');
  await expect.poll(() => state.drafts.production.config.navigation.icons?.deals).toBe('location');
  await page.getByRole('button', { name: 'Remove deals tab', exact: true }).click();
  await expect.poll(() => state.drafts.production.config.navigation.tabs.includes('deals')).toBe(false);
  expect(state.drafts.production.config.navigation.icons?.deals).toBeUndefined();
  await page.getByRole('button', { name: 'Release readiness', exact: true }).click();
  await expect(report).toContainText('Backend validation required');
});

test('sections editor saves native product and banner settings without lowering runtimes', async ({ page }) => {
  const state = await setup(page);
  await ready(page);
  const originalBrand = structuredClone(state.drafts.production.config.brand);
  await page.getByRole('button', { name: 'Sections', exact: true }).click();
  await expect(page.locator('.ms-preview-area')).toBeHidden();
  await page.getByLabel('Add section', { exact: true }).selectOption('productGrid');
  await expect(page.getByLabel('Product limit', { exact: true })).toHaveValue('24');
  await page.getByLabel('Product limit', { exact: true }).fill('6');
  await page.getByRole('combobox', { name: 'Columns', exact: true }).selectOption('1');
  await expect.poll(() => state.drafts.production.config.screens.home.sections.at(-1)?.props).toMatchObject({ limit: 6, columns: 1 });
  await expect.poll(() => state.drafts.production.config.compatibility).toEqual({ minIosRuntime: '1.2.0', minAndroidRuntime: '1.2.0' });
  await page.getByLabel('Add section', { exact: true }).selectOption('heroBanner');
  await page.getByLabel('Banner layout', { exact: true }).selectOption('portrait');
  await page.getByLabel('Image fitting', { exact: true }).selectOption('contain');
  await expect.poll(() => state.drafts.production.config.compatibility).toEqual({ minIosRuntime: '1.3.0', minAndroidRuntime: '1.3.0' });
  await page.getByLabel('Home presentation', { exact: true }).selectOption('storefront');
  await expect.poll(() => state.drafts.production.config.screens.home.layout).toBe('storefront');
  await page.getByLabel('Banner layout', { exact: true }).selectOption('legacy');
  await page.getByLabel('Home presentation', { exact: true }).selectOption('standard');
  await expect.poll(() => state.drafts.production.config.screens.home.layout).toBe('standard');
  expect(state.drafts.production.config.compatibility).toEqual({ minIosRuntime: '1.3.0', minAndroidRuntime: '1.3.0' });
  expect(state.drafts.production.config.brand).toEqual(originalBrand);
  const first = state.drafts.production.config.screens.home.sections[0].id;
  await page.getByRole('button', { name: `Move ${first} down`, exact: true }).click();
  await expect.poll(() => state.drafts.production.config.screens.home.sections[1].id).toBe(first);
  await page.reload();
  await ready(page);
  await page.getByRole('button', { name: 'Sections', exact: true }).click();
  await expect(page.getByLabel('Home presentation', { exact: true })).toHaveValue('standard');
  expect(state.drafts.production.config.compatibility.minIosRuntime).toBe('1.3.0');
});

test('sections workspace and library fit phone tablet and desktop without previews', async ({ page }, testInfo) => {
  await setup(page);
  await ready(page);
  await page.getByRole('button', { name: 'Sections', exact: true }).click();
  const builder = page.locator('.ms-section-builder');
  await expect(page.getByRole('region', { name: 'Home screen structure' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Selected section settings' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('sections-desktop.png'), fullPage: true });
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect.poll(() => builder.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await expect(page.locator('.ms-preview-area')).toBeHidden();
    await page.getByRole('button', { name: 'Component library', exact: true }).click();
    await expect.poll(() => builder.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    if (width === 1440 || width === 390) await page.screenshot({ path: testInfo.outputPath(`sections-library-${width}.png`), fullPage: true });
    await page.getByRole('button', { name: 'Close library', exact: true }).click();
  }
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const type of ['productGrid', 'productCarousel', 'categoryGrid', 'richText', 'spacer']) {
      await page.getByLabel('Add section', { exact: true }).selectOption(type);
      const inspector = page.getByRole('region', { name: 'Selected section settings' });
      await expect.poll(() => builder.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      await expect.poll(() => inspector.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      if (width === 390 && type === 'productGrid') {
        await inspector.scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath('sections-product-mobile.png'), fullPage: true });
      }
    }
  }
});

test('readiness exposes validation destinations without granting operators publish access', async ({ page }) => {
  const state = await setup(page, 'operator');
  state.drafts.production.config.brand.light.onPrimary = state.drafts.production.config.brand.light.primary;
  await ready(page);
  await page.getByRole('button', { name: 'Release readiness', exact: true }).click();
  const report = page.getByLabel('Release readiness report');
  await expect(report).toContainText('INSUFFICIENT CONTRAST');
  await expect(report).toContainText('An owner must approve');
  await expect(page.getByRole('button', { name: 'Review & publish', exact: true })).toBeDisabled();
  await report.getByRole('button', { name: 'Open Brand & theme', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Brand & theme', exact: true })).toBeVisible();
  expect(state.writes).toBe(0);
});


test("asset library searches, filters usage and opens image details", async ({ page }) => {
  await setup(page); await ready(page);
  await page.getByRole('button', { name: 'Assets', exact: true }).click();
  const library = page.getByRole('region', { name: 'Asset library' });
  await expect(library.getByRole('button', { name: 'Current logo' })).toBeDisabled();
  await library.getByLabel('Search images').fill('missing');
  await expect(library.getByText('No matching images')).toBeVisible();
  await library.getByRole('button', { name: 'Clear search' }).click();
  await library.getByRole('button', { name: 'View Market logo' }).click();
  const details = page.getByRole('dialog', { name: 'Image details' });
  await expect(details.getByText('16 × 12 px')).toBeVisible();
  await expect(details.getByText('image/png')).toBeVisible();
  await page.keyboard.press('Escape'); await expect(details).not.toBeVisible();
});

test("asset library blocks uploads for operators", async ({ page }) => {
  await setup(page, 'operator'); await ready(page);
  await page.getByRole('button', { name: 'Assets', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Upload images', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'View Market logo' }).click();
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Use as logo' })).toBeDisabled();
});

test("batch uploads retain failed images for retry", async ({ page }) => {
  await setup(page); let attempts = 0;
  await page.route('**/api/v1/merchants/*/assets?*', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    attempts++;
    if (attempts === 2) return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Upload unavailable' }) });
    return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ id: `10000000-0000-0000-0000-00000000000${attempts + 3}`, name: attempts === 1 ? 'First' : 'Second', kind: 'image', verified: true, url: null, width: 16, height: 12, contentType: 'image/png', checksum: 'b'.repeat(64), sizeBytes: 100 }) });
  });
  await ready(page);
  await page.getByRole('button', { name: 'Assets', exact: true }).click();
  await page.getByRole('button', { name: 'Upload images', exact: true }).click();
  await page.getByLabel('Image files').setInputFiles(['first.png', 'second.png'].map(name => ({ name, mimeType: 'image/png', buffer: Buffer.from('fixture') })));
  await page.getByRole('button', { name: 'Upload 2 images' }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Remaining images are ready to retry');
  await expect(page.getByLabel('Name for first.png')).toHaveCount(0);
  await expect(page.getByLabel('Name for second.png')).toBeVisible();
  await page.getByRole('button', { name: 'Upload 1 image' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0); expect(attempts).toBe(3);
});

async function setupBannerControls(page: Page, role = 'owner') {
  const state = await setup(page, role);
  const images = Array.from({ length: 9 }, (_, i) => ({
    id: i === 0 ? fixture.brand.logoAssetId : `d3d03c49-c514-40fc-b251-cc6bf3b7190${i}`,
    name: `Campaign artwork ${i + 1}`, kind: 'image', verified: true, url: null,
    width: 800, height: 1200, contentType: 'image/png', checksum: 'b'.repeat(64), sizeBytes: 100,
  }));
  await page.route('**/api/v1/merchants/*/assets?*', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(images) }));
  const c = state.drafts.production.config;
  const hero = c.screens.home.sections.find(s => s.type === 'heroBanner')!;
  if (hero.type !== 'heroBanner') throw new Error('Missing hero');
  Object.assign(hero.props, { imageAssetId: images[0].id, additionalImageAssetIds: [images[1].id, images[2].id], layout: 'portrait', imageFit: 'cover' });
  c.compatibility = { minIosRuntime: '1.3.0', minAndroidRuntime: '1.3.0' };
  await ready(page);
  await page.getByRole('button', { name: 'Sections', exact: true }).click();
  const saved = () => {
    const section = state.drafts.production.config.screens.home.sections.find(s => s.id === hero.id)!;
    if (section.type !== 'heroBanner') throw new Error('Wrong section');
    return section.props;
  };
  return { state, images, saved };
}

test('banner controls reorder replace and remove slides without duplicate image choices', async ({ page }, testInfo) => {
  const { images, saved } = await setupBannerControls(page);
  const before = structuredClone(saved());
  const first = page.getByLabel('Banner image', { exact: true });
  await expect(first.locator(`option[value="${images[1].id}"]`)).toHaveCount(0);
  await expect(page.getByLabel('Slide 2', { exact: true }).locator(`option[value="${images[0].id}"]`)).toHaveCount(0);
  await page.getByRole('button', { name: 'Move image 3 earlier', exact: true }).click();
  await expect.poll(() => saved().additionalImageAssetIds).toEqual([images[2].id, images[1].id]);
  await page.getByRole('button', { name: 'Move image 1 later', exact: true }).click();
  await expect.poll(() => saved().imageAssetId).toBe(images[2].id);
  await first.selectOption(images[3].id);
  await expect.poll(() => saved().imageAssetId).toBe(images[3].id);
  await page.getByRole('button', { name: 'Remove image 1', exact: true }).click();
  await expect.poll(() => saved().imageAssetId).toBe(images[0].id);
  await expect.poll(() => saved().additionalImageAssetIds).toEqual([images[1].id]);
  expect(saved().action).toEqual(before.action);
  expect(saved().accessibilityLabelKey).toBe(before.accessibilityLabelKey);
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect.poll(() => page.locator('.ms-section-inspector').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await expect(page.locator('.ms-preview-area')).toBeHidden();
  }
  await page.locator('.ms-banner-settings').screenshot({ path: testInfo.outputPath('banner-controls.png') });
  await page.reload(); await ready(page);
  await page.getByRole('button', { name: 'Sections', exact: true }).click();
  await expect(page.getByLabel('Slide 2', { exact: true })).toHaveValue(images[1].id);
});

test('banner controls confirm destructive layout changes and enforce the eight image limit', async ({ page }) => {
  const { images, saved, state } = await setupBannerControls(page);
  const layout = page.getByLabel('Banner layout', { exact: true });
  await layout.selectOption('legacy');
  const confirm = page.getByRole('group', { name: 'Confirm single image layout' });
  await expect(confirm).toBeVisible();
  expect(saved().additionalImageAssetIds).toHaveLength(2);
  await page.getByRole('button', { name: 'Keep carousel', exact: true }).click();
  await expect(confirm).toBeHidden();
  await expect(layout).toHaveValue('portrait');
  for (let i = 0; i < 5; i++) await page.getByRole('button', { name: 'Add carousel image', exact: true }).click();
  await expect.poll(() => saved().additionalImageAssetIds).toHaveLength(7);
  await expect(page.getByRole('button', { name: 'Add carousel image', exact: true })).toBeDisabled();
  await expect(page.getByText('Eight-image limit reached.', { exact: true })).toBeVisible();
  await layout.selectOption('horizontal');
  await expect.poll(() => saved().layout).toBe('horizontal');
  expect(saved().additionalImageAssetIds).toHaveLength(7);
  await layout.selectOption('legacy');
  await page.getByRole('button', { name: 'Keep first image only', exact: true }).click();
  await expect.poll(() => saved().layout).toBeUndefined();
  expect(saved().additionalImageAssetIds).toBeUndefined();
  expect(saved().imageAssetId).toBe(images[0].id);
  expect(state.drafts.production.config.compatibility.minIosRuntime).toBe('1.3.0');
});

test('banner controls explain missing images and respect read only access', async ({ page }) => {
  const { state } = await setupBannerControls(page, 'operator');
  await expect(page.getByLabel('Banner image', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Move image 1 later', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Remove image 1', exact: true })).toBeDisabled();
  expect(state.writes).toBe(0);
  await page.route('**/api/v1/merchants/*/assets?*', route => route.fulfill({ contentType: 'application/json', body: '[]' }));
  await page.reload(); await ready(page);
  await page.getByRole('button', { name: 'Sections', exact: true }).click();
  await expect(page.getByText('This image is unavailable or unverified. Choose another image, or upload one in Assets.', { exact: true })).toHaveCount(3);
  expect(state.writes).toBe(0);
});


test('asset folders persist hierarchy, bulk moves and deletion preserves images', async ({ page }) => {
  await setup(page); await ready(page);
  await page.getByRole('button', { name: 'Assets', exact: true }).click();
  await page.getByRole('button', { name: 'New folder', exact: true }).click();
  await page.getByLabel('Folder name', { exact: true }).fill('Campaigns');
  await page.getByRole('button', { name: 'Save folder' }).click();
  await expect(page.getByRole('heading', { name: 'Campaigns', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'New folder', exact: true }).click();
  await page.getByLabel('Folder name', { exact: true }).fill('Summer');
  await page.getByRole('button', { name: 'Save folder' }).click();
  await expect(page.getByRole('heading', { name: 'Summer', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Rename or move folder', exact: true }).click();
  await expect(page.getByLabel('Parent folder').locator('option')).toHaveCount(2);
  await page.getByLabel('Folder name', { exact: true }).fill('Summer sale');
  await page.getByRole('button', { name: 'Save folder' }).click();
  await page.getByRole('navigation', { name: 'Asset folders' }).getByRole('button', { name: 'All images', exact: true }).click();
  await page.getByLabel('Select Market logo', { exact: true }).check();
  await page.getByRole('button', { name: 'Move selected' }).click();
  await page.getByLabel('Destination folder').selectOption({ label: 'Campaigns / Summer sale' });
  await page.getByRole('button', { name: 'Move images', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('navigation', { name: 'Asset folders' }).getByRole('button', { name: /Summer sale/ }).click();
  await expect(page.getByRole('button', { name: 'View Market logo' })).toBeVisible();
  await page.getByRole('navigation', { name: 'Media path' }).getByRole('button', { name: 'Campaigns', exact: true }).click();
  await page.getByRole('button', { name: 'Rename or move folder', exact: true }).click();
  await expect(page.getByLabel('Parent folder').locator('option')).toHaveCount(1);
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Delete folder', exact: true }).click();
  await page.getByRole('button', { name: 'Delete folder and keep images' }).click();
  await expect(page.getByRole('heading', { name: 'Unfiled', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'View Market logo' })).toBeVisible();
  await page.reload(); await page.getByRole('button', { name: 'Assets', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Asset folders' }).getByRole('button', { name: /Campaigns/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'View Market logo' })).toBeVisible();
});


test('hosted deployment keeps unsupported product screen fields read-only', async ({ page }) => {
  test.skip(process.env.VITE_PRODUCT_SCREEN_CONTROLS_ENABLED !== 'false', 'Production capability gate');
  const state = await setup(page);
  await ready(page);
  await page.getByRole('button', { name: 'Features', exact: true }).click();
  await expect(page.getByLabel('Show wishlist icon on products', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('Show compare icon on products', { exact: true })).toBeDisabled();
  await expect(page.getByText('Product icon visibility settings are not available on this deployment yet.', { exact: false })).toBeVisible();
  expect(state.writes).toBe(0);
  expect(state.drafts.production.config.screens.product).toBeUndefined();
});
