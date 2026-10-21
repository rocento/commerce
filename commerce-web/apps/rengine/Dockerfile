FROM node:22.18-alpine
WORKDIR /app
COPY --chown=node:node package.json *.mjs ./
COPY --chown=node:node rulebook.json ./
COPY --chown=node:node public ./public
USER node
ENV HOST=0.0.0.0 PORT=3190
EXPOSE 3190
CMD ["node", "server.mjs"]
