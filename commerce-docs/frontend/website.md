# Corporate website

`commerce-corporate-site` is an isolated Next.js/React/TypeScript marketing application. [Next configuration](../../commerce-corporate-site/next.config.ts) enables static export, trailing-slash routes and unoptimized images. It does not use the merchant commerce runtime or database.

From `commerce-web`:

```sh
pnpm dev:website
pnpm build:website
pnpm --filter @rocento/website typecheck
pnpm --filter @rocento/website verify
pnpm --filter @rocento/website preview
```

Development and static preview bind 127.0.0.1:5180. Preview needs Python 3 and serves `out`. Build runs Next with webpack. Deploy only the completed `out` directory to a static host serving directory indexes and HTTP 404 from `404.html`; `next start` is not this application's runtime.

Set `SITE_URL` to the intended public origin and rebuild for canonical, Open Graph and sitemap output. Without configuration the preview is noindex. Demo links use `NEXT_PUBLIC_PHARMACY_DEMO_URL`, `NEXT_PUBLIC_ELECTRONICS_DEMO_URL`, `NEXT_PUBLIC_GROCERY_DEMO_URL` and `NEXT_PUBLIC_JEWELRY_DEMO_URL`; absent destinations show disclosures. They do not seed or switch merchant demos. Industry detail pages link to their matching configured demo. The pharmacy use case is published at `/industries/pharmacy/` and included in the industry index, sitemap and `llms.txt`. Final contact/legal publication placeholders need authored values before launch.

## Source and content

| Source | Ownership |
| --- | --- |
| `app/` | Static routes, metadata, sitemap and article pages |
| `components/` | Navigation, sections, article cards and filtering |
| `lib/site.ts` | Site metadata, capabilities and demo definitions |
| `lib/knowledge.ts` | Build-time article loading, slug, reading time and headings |
| `content/knowledge/*.txt` | Published article source with JSON front matter and Markdown body |
| `app/globals.css` | Responsive styles, focus states and motion policy |
| `scripts/verify-export.py` | HTML routes, links, anchors, assets and metadata verification |
| `public/docs/api/` | Reviewed public OpenAPI artifact and isolated read-only reference shell |
| `scripts/prepare-api-docs.mjs` | Copies the pinned Swagger distribution assets for development and static builds |
| `scripts/test-api-docs.mjs` | Browser interaction, credential isolation, request and CSP regression checks |

Article front matter uses JSON between `---` delimiters and requires string title, summary, author, date and category; tags accompany that metadata. Slugs derive from filenames and reading time from body length. The four existing articles were renamed from `.md` to `.txt` without changing bytes or URLs. Raw HTML remains disabled by the article renderer.

Read the installed Next documentation in `node_modules/next/dist/docs` before framework changes; the installed version can differ from older conventions. The source `AGENTS.md`/`CLAUDE.md` files were removed as requested. Next development tooling can regenerate its agent guidance, so include a Markdown inventory in future cleanup checks.

Essays express product positioning, not research findings or proof of autonomous capability. Preserve factual scope when changing copy. Run static build, typechecking and export verification after content/loader changes, with browser checks when layout or interaction changes.

## Product documentation hub

`/docs/` is the public product handbook. `lib/docs-content.ts` owns the structured product articles, and `lib/docs.ts` registers them with the interactive fulfillment guide. Add a stable slug, category, audience, section IDs and related articles when adding a guide. The same registry supplies the sidebar, full-text search, sitemap and `llms.txt`; retain existing URLs and anchors when revising content.

`app/docs/(guides)/layout.tsx` provides documentation navigation and search for the handbook. The explicit `app/docs/api/page.tsx` route renders the API reference as a separate, full-width screen at `/docs/api/`, without the handbook sidebar or search toolbar. The index offers a compact guide directory and a store-setup entry point. The article route renders semantic sections, tables, callouts, related guides and a contents navigation. `app/docs/docs.css` scopes the responsive documentation presentation: Source Sans 3, a neutral collapsible sidebar, a readable article column and a right-hand contents list. The self-hosted font and its OFL license live in `public/docs/fonts/`. `components/docs-screenshot.tsx` places four sample-data screenshots from `public/docs/images/` in relevant guides; each links to its full-size original. Source images come from the overview, product-grid, theme-editor and checkout regression fixtures, not customer records. Keep captions, alternate text and fixture provenance when replacing images. Product behavior must be checked against the owning source and current admin labels before publication; publication dates are editorial review dates, not automated deployment timestamps.

The former Admin Support → Guide lives at `/docs/fulfillment/`. `components/fulfillment-guide.tsx` retains the delivery/pickup walkthrough, module reference, setup order and troubleshooting. Admin's `src/guide.tsx` sends in-app navigation to that public URL. Its source-owned `public/support/guide/index.html` also handles direct unauthenticated visits, and preserves `#guide-flow`, `#guide-modules`, `#guide-setup` and `#guide-help`. Both entry points survive future builds. API documentation retains its isolated reference viewer described below.

Validate every exported route, metadata record, anchor and related link with the static verifier, then check search, mobile navigation, article tables, fulfillment toggles and legacy redirects in a browser. The platform-docs release evidence records the exact published source hashes and preserves the already deployed API response policies.

## API documentation

`/docs/api/` provides the API overview and a Swagger UI reference. The reference is a preview of selected storefront and customer operations; it does not promise a stable third-party API or self-service integration credentials. Keep that scope explicit when changing the copy. [Backend API maintenance](../backend/api.md) owns the contract publication policy and authentication guidance.

The viewer uses the pinned `swagger-ui-dist` version `5.33.1` with local JavaScript and CSS. Its specification is the reviewed artifact at `public/docs/api/openapi.json`, generated from an explicit allowlist by `commerce-ops/scripts/generate_public_openapi.py`. Never point the viewer at the complete backend contract or accept a specification URL from the page query string. Do not add CDN assets, remote validators, persistent authorization or a production “Try it out” button. The read-only reference must not collect credentials or execute API operations.

The embedded `/docs/api/reference/` viewer has a separate restrictive content security policy at managed ingress. Documentation responses also receive MIME-sniffing, framing, referrer and permissions restrictions. The main Next page and the isolated viewer need separate policies because the static Next export uses inline bootstrap scripts. Header rules live in `commerce-ops/deploy/ec2/configure.py`; static preview validates output and behavior but does not reproduce production HTTP headers.

Regenerate the public contract deliberately before building after an API change:

```sh
# From the repository root:
python3 commerce-ops/scripts/generate_public_openapi.py
python3 commerce-ops/scripts/generate_public_openapi.py --check
python3 -m unittest discover -s commerce-ops/scripts/tests -p 'test_public_openapi.py'

# From commerce-web:
pnpm --filter @rocento/website typecheck
pnpm build:website
pnpm --filter @rocento/website verify
```

The website build prepares the pinned local Swagger assets and validates the public contract's expected identity and route boundaries. CI separately checks for a stale public contract, runs the website through the workspace typecheck/build, and verifies the export. Review the documentation in a browser after viewer or layout changes, including narrow screens, endpoint expansion, search and the absence of execution and authorization controls. With the static preview running, execute the browser security and interaction checks from `commerce-corporate-site`:

```sh
API_DOCS_BASE_URL=http://127.0.0.1:5180 node scripts/test-api-docs.mjs
```

These checks require the workspace Playwright Chromium browser. They verify local-only read requests, disabled credential/execution controls, blocked specification URL overrides, the viewer's inline-script CSP and narrow-screen layout. The frontend CI job installs Chromium and runs this browser check against its static website export, alongside the authenticated merchant viewer regression. Production HTTP header checks remain part of release verification.

Only publish a verified static export. The scoped `commerce-ops/deploy/ec2/server/ec2-publish-website.py` command updates the corporate website release and documentation ingress rules without rebuilding the commerce applications. It validates Nginx and supports rollback on publication failure. Stage the script and `commerce-ops/deploy/ec2/configure.py` with their repository-relative layout intact on the deployment host, then inspect the proposed release:

```sh
sudo python3 commerce-ops/deploy/ec2/server/ec2-publish-website.py --source /absolute/staged/export --root /opt/rocento --domain rocento.com --dry-run
```

After the dry run succeeds, the same command without `--dry-run` publishes the staged export under the normal deployment access controls. Verify the public page, local viewer assets, response headers and blocked `/api/openapi.json` paths after release; the publisher's origin probes do not replace verification through the public Cloudflare edge. Public reference changes can use the website-only release. Changes to the protected merchant endpoint require a tested gateway release; its admin viewer also requires the corresponding admin build. Keep those builds isolated from unrelated in-progress work.

### Authenticated merchant viewer

The merchant viewer belongs to `commerce-web/apps/admin`, under **System → API reference**, gated by `api.docs.read`. Static `/api-reference/` contains only the pinned self-hosted viewer assets; it fetches its contract from `/api/v1/admin/api-reference/openapi.json` after server-side session and permission checks. It never bundles the private JSON. Run `node e2e/api-reference/merchant-reference.mjs` from `commerce-web` after preparing the admin assets to test denied/allowed/revoked views, execution/configuration restrictions, storage and mobile layout.
