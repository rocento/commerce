# Build with commerce-web as the context. Only the onboarding-ops workspace is installed.
FROM node:22-bookworm-slim
ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_PUBLIC_ONBOARDING_ENV=test
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/onboarding-ops ./apps/onboarding-ops
COPY packages/ui/src/brand ./packages/ui/src/brand
RUN pnpm --filter @rocento/onboarding-ops install --frozen-lockfile
RUN pnpm build:onboarding-ops
ENV NODE_ENV=production
USER node
WORKDIR /app/apps/onboarding-ops
CMD ["node", "node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3101"]
