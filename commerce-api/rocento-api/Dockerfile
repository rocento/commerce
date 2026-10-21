FROM rust:1.94-bookworm AS build
WORKDIR /app
COPY . .
RUN cargo build --release --locked -p api-gateway --bins
FROM debian:bookworm-slim
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/target/release/api-gateway /usr/local/bin/api-gateway
COPY --from=build /app/target/release/seed-admin /usr/local/bin/seed-admin
COPY --from=build /app/target/release/sync-reports /usr/local/bin/sync-reports
COPY --from=build /app/target/release/export-worker /usr/local/bin/export-worker
COPY --from=build /app/target/release/install-catalog-data /usr/local/bin/install-catalog-data
COPY --from=build /app/target/release/prepare-storefront-images /usr/local/bin/prepare-storefront-images
COPY --from=build /app/target/release/engagement-worker /usr/local/bin/engagement-worker
COPY --from=build /app/target/release/analytics-worker /usr/local/bin/analytics-worker
USER 10001:10001
EXPOSE 8080
CMD ["api-gateway"]
