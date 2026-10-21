# EC2 and Cloudflare deployment

Use [deployment commands](../../../commerce-ops/deploy/aws-deploy/README.md) from the workstation and [EC2 provisioning](../../../commerce-ops/deploy/ec2/README.md) on the server. The deployment scripts own generated Compose, Nginx and frontend release configuration; maintain those sources instead of copying a second manual deployment recipe.

## Topology

All configured public hostnames point to the installation's Elastic IP. Cloudflare handles public HTTPS and Nginx uses the configured origin certificate. Applications call `/api` on their own hostname.

| Host under the configured domain | Purpose | Loopback gateway |
| --- | --- | --- |
| Apex / `www` | Corporate website / redirect | Static Next.js export |
| `grocery` / `admin` | Grocery storefront / admin | 8080 |
| `jewelry` / `jewelry-admin` | Jewelry storefront / admin | 58080 |
| `electronics` / `electronics-admin` | Electronics storefront / admin | 59080 |
| `pharmacy` / `pharmacy-admin` | Pharmacy storefront / admin | 60080 |

Each store has its own commerce installation, credentials and persistent volumes. Sales channels do not isolate businesses. Shared backend and assistant image tags reduce duplicate builds; they do not merge commerce databases. Consolidated AI persistence uses separate tenant identities and policies described in [shared AI database operations](../../ai-service/shared-database-operations.md).

## Provisioning checklist

1. Provision the supported Ubuntu host and persistent storage described in the EC2 guide. Size capacity from actual workload and build measurements.
2. Keep SSH restricted to administrative access and backend/database ports private. Nginx owns public HTTP/HTTPS ingress.
3. Configure the apex, `www`, and all eight store/admin DNS records. Preserve existing mail and verification records.
4. Configure Cloudflare **Full (strict)** and an origin certificate covering the apex and required subdomains. Keep its private key and bootstrap credentials outside Git.
5. Prepare the protected bootstrap configuration and run the deployment tooling. Configure customer mail through [SMTP setup](../../../commerce-ops/deploy/aws-deploy/SMTP.md).
6. Prepare and explicitly promote the matching language release using [the release lifecycle](../../ai-service/language-release-upgrade.md). Runtime startup verifies the active release; restarting a service does not publish a dictionary.

## Application data and seeding

Deploying source does not copy workstation databases or uploaded media. Deployment preserves existing volumes and does not seed catalogs. Use `bash commerce-ops/deploy/aws-deploy/seed-demo.sh --store pharmacy` (or the intended store) only when initializing or updating that managed demo. `--store all` includes all four stores. See [assets and demos](../../frontend/assets-and-demos.md) and [client onboarding](client-onboarding.md) for catalog, inventory and delivery requirements.

## Verification and recovery

Use `commerce-ops/deploy/ec2/server/ec2-status.sh`, `commerce-ops/deploy/ec2/server/ec2-doctor.sh` and `commerce-ops/deploy/ec2/server/ec2-compose.sh` on the server for installation-aware checks. Verify each public hostname, same-origin API, administrator permissions, catalog isolation, customer journey, mail configuration and assistant readiness. Static demo hosting alone does not validate [merchant publication](../../backend/publication.md).

Keep application-consistent backups off the instance and rehearse restoration separately. Database dumps alone do not preserve uploaded media, other service data, configuration or TLS keys. Never prune production volumes as source cleanup. See [durability and recovery](../operations/durability.md) and [shared AI recovery](../../ai-service/shared-database-operations.md).

Keep the previous source/images and frontend release for rollback. Database migrations and language release promotion have their own recovery procedures; reverting an image does not undo them. [The release runbook](../../../commerce-ops/deploy/aws-deploy/how.md) covers migration history checks and managed cleanup behavior.
