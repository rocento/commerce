ARG RUST_IMAGE=rust:1.94.1-bookworm
FROM node:22-bookworm-slim AS node
FROM ${RUST_IMAGE}
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /workspace/backend
RUN apt-get update && apt-get install -y --no-install-recommends chromium nginx openssl python3 && rm -rf /var/lib/apt/lists/*
