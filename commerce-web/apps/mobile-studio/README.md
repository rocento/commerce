# Rocento App Studio

The browser-based Mobile App Studio is a Vite application in the `commerce-web`
pnpm workspace. Its native storefront clients live in the sibling
`commerce-mobile-apps/` project.

Run it from the workspace root:

```sh
pnpm install
pnpm dev:mobile-studio
```

The API client is consumed as the workspace package
`@commerce/api-client`. When its mobile contract changes, regenerate and check
the browser validator from `commerce-web/` before building:

```sh
pnpm exec node packages/api-client/scripts/generate-mobile-validator.mjs --check
pnpm build:mobile-studio
pnpm --filter @rocento/mobile-admin test
```

`pnpm build:mobile-studio` writes the static bundle to
`apps/mobile-studio/dist/`; `pnpm --filter @rocento/mobile-admin preview`
serves it on port 5194 for browser checks.
