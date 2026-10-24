#!/usr/bin/env bash
# Runs inside an ephemeral Node container, with a private copy of the source.
set -Eeuo pipefail
cp -a /source/. /app/
cd /app
# Do not load development URLs or secrets from a copied local environment.
find . -type f -name '.env*' -delete
npm install -g pnpm@10.32.1
pnpm install --frozen-lockfile
# Generate client types from this release's contract before compiling consumers.
pnpm generate:api
SITE_URL="https://$DOMAIN" \
  NEXT_PUBLIC_GROCERY_DEMO_URL="https://grocery.$DOMAIN" \
  NEXT_PUBLIC_PHARMACY_DEMO_URL="https://pharmacy.$DOMAIN" \
  NEXT_PUBLIC_ELECTRONICS_DEMO_URL="https://electronics.$DOMAIN" \
  NEXT_PUBLIC_JEWELRY_DEMO_URL="https://jewelry.$DOMAIN" \
  pnpm --filter @rocento/website build
mkdir -p /public/{website,storefront,grocery-admin,jewelry-admin,electronics-admin,pharmacy-admin,mobile-admin}
cp -a apps/website/out/. /public/website/
VITE_SALES_CHANNEL=storefront pnpm --filter @commerce/storefront build
cp -a apps/storefront/dist/. /public/storefront/
VITE_STOREFRONT_URL="https://grocery.$DOMAIN" pnpm --filter @commerce/admin build
cp -a apps/admin/dist/. /public/grocery-admin/
VITE_STOREFRONT_URL="https://jewelry.$DOMAIN" pnpm --filter @commerce/admin build
cp -a apps/admin/dist/. /public/jewelry-admin/

VITE_STOREFRONT_URL="https://electronics.$DOMAIN" pnpm --filter @commerce/admin build
cp -a apps/admin/dist/. /public/electronics-admin/

VITE_STOREFRONT_URL="https://pharmacy.$DOMAIN" pnpm --filter @commerce/admin build
cp -a apps/admin/dist/. /public/pharmacy-admin/

# Independent mobile merchant application; never copy the core admin bundle here.
VITE_ANDROID_EC2_ENABLED=true VITE_IOS_PREVIEW_ENABLED=false \
  VITE_RN_ANDROID_PREVIEW_ENABLED=true VITE_RN_PREVIEW_ENABLED=false \
  VITE_PRODUCT_SCREEN_CONTROLS_ENABLED=false \
  pnpm --filter @rocento/mobile-admin build
cp -a apps/mobile-admin/dist/. /public/mobile-admin/
