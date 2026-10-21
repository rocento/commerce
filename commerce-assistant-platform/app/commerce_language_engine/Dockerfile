FROM node:22.18-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --chown=node:node src ./src
COPY --chown=node:node seeds ./seeds
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node public ./public
COPY --chown=node:node data ./data
USER node
RUN node scripts/check-release.ts
ENV HOST=0.0.0.0 PORT=3000
EXPOSE 3000
CMD ["node", "scripts/deploy-start.ts"]
