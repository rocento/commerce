FROM node:22-bookworm-slim
RUN npm install -g pnpm@10.32.1
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps ./apps
COPY packages ./packages
COPY eslint.config.js ./
RUN pnpm install --frozen-lockfile
ARG APP=storefront
ENV APP=$APP
CMD pnpm --filter @commerce/$APP dev
