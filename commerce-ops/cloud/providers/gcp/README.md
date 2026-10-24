# Google Cloud deployment

This launcher stages the current checkout on a Compute Engine VM, then invokes
the [shared deployment-host commands](../../../deploy/ec2/server/README.md) and production
release gate:

```bash
mkdir -p .local/commerce-ops/targets
cp commerce-ops/config/examples/production-gcp.env .local/commerce-ops/targets/production-gcp.env
chmod 600 .local/commerce-ops/targets/production-gcp.env
# Review the named target and local key path, then:
bash commerce-ops/cloud/providers/gcp/deploy.sh
```

Set project, zone, instance, host and the local SSH key path in the ignored
`.local/commerce-ops/targets/production-gcp.env` file. `HOST` may hold the reserved external address; otherwise set `PROJECT`, `ZONE`,
and `INSTANCE` and the launcher resolves it with `gcloud`. The key
must match the public key installed in GCE SSH metadata. Complete the
[shared production prerequisites](../../../deploy/README.md#before-a-production-deployment)
before activation.

Add the **public** SSH key matching `SSH_KEY` or the `GCLOUD_SSH_KEY` override to the VM or project SSH
metadata with the username `ubuntu`. Keep the private key in its existing
protected local path; never copy it into this repository or the VM. The current
server activation expects the remote account to be `ubuntu`, passwordless sudo,
and `rsync`. `gcloud` CLI login is needed only when `GCLOUD_HOST` is omitted.

## Production prerequisites

This is a transport and activation entry point, not a production-readiness
waiver. Before running it:

- Create `.local/commerce-ops/secrets/gcp/bootstrap.env` from
  `commerce-ops/deploy/ec2/bootstrap.env.example`, set real domain/admin values and paths
  `/home/ubuntu/.rocento-secrets/rocento-origin.pem` and
  `/home/ubuntu/.rocento-secrets/rocento-origin.key`, then `chmod 600` it.
- Place the matching Cloudflare Origin CA files at
  `.local/commerce-ops/secrets/gcp/origin.pem` and
  `.local/commerce-ops/secrets/gcp/origin.key`, both mode 600. Configure DNS and Full (strict) TLS for all
  domains expected by the server deployment.
- Prepare the root-owned `/etc/rocento/release` authorization packet on the VM
  for this exact checkout, machine ID, operation, bootstrap file, and evidence.
  The production gate rejects missing, stale, mismatched, or altered evidence.
- Load the exact reviewed ARM64 application images and frontend artifact on the
  VM. Production deployment does not build or approve release artifacts.
- Provide adequate VM memory and free persistent disk for all services, image
  layers, database volumes, and growth. The server preflight enforces
  only its existing minimum; that is not a capacity qualification.

## Same-domain migration from AWS

For the current `rocento.com` installation, leave Cloudflare DNS pointed at the
AWS origin while preparing GCP. The GCP launcher records the VM's external IP
in its private upload stage. During activation, server-side HTTPS checks connect
directly to that IP while sending each real hostname as SNI/Host, and pin the
TLS certificate to the configured Cloudflare Origin certificate. This validates
the GCP Nginx origin without mistaking responses from the still-live AWS origin
for GCP health. It does not switch public traffic.

Source and container deployment alone does **not** migrate customer data. Before
DNS cutover, prepare and rehearse a complete consistent data/configuration move:
all commerce and AI PostgreSQL databases, MinIO media, NATS JetStream state,
ClickHouse reporting data, required Meilisearch indexes or rebuild procedure,
runtime secrets/configuration, and language release state. Agree on a write
freeze and final sync. The release readiness packet must include acceptance
against the exact GCP candidate. Do not point any
customer hostname to GCP until those checks pass and all origin checks are green.

After GCP acceptance, cut over the complete Cloudflare hostname set from the
existing AWS address to the GCP address together, keep Cloudflare proxying and
Full (strict) TLS enabled, and monitor the documented health/checkout signals.
The GCP script
does not edit DNS or provide a data-copy operation.

## Seed demo data on an existing GCP deployment

Demo seeding has one provider-neutral host procedure. The GCP launcher reads
the configured `production-gcp` target, resolves its direct-origin IPv4 address
from `HOST` or `PROJECT`/`ZONE`/`INSTANCE`, and uses its local `SSH_KEY`:

```bash
bash commerce-ops/cloud/providers/gcp/seed-demo.sh --store grocery
```

The named operator command is
`python3 commerce-ops/bin/ops cloud demo seed --target production-gcp --store grocery`.
It uploads only seed helpers and selected demo data, then runs the host seeder
under the existing deployment lock. It does not deploy platform code, build
images, or restart services. Review [demo seeding](../../../tasks/demo-seeding.md)
for store scopes and delivery-only options.

The current service configuration retains its Cloudflare ingress assumptions
and the demo notification mode. Real customer orders require production email
delivery to be configured and reviewed before enabling that flow. Do not treat
a successful VM boot or container health check as production acceptance.

`--dry-run` previews filtered uploads against an existing `/opt/rocento` tree.
It does not upload configuration or run activation. `--preserve-ai` keeps an
existing verified AI release while updating commerce services.

Target files are stored in `.local/commerce-ops/targets/`; private bootstrap and
origin files are stored in `.local/commerce-ops/secrets/gcp/`. These paths are
ignored by Git. Do not commit them.

## Target loader ownership

`target.sh` owns parsing for the deployment and demo-seed launchers. Target
files are literal `KEY=value` data, never shell code. The loader rejects duplicate
or unsupported fields and requires `PROVIDER=gcp`; `SSH_USER`, when specified,
must be `ubuntu`. Existing values supplied by environment or command arguments
win over file defaults. Callers retain their existing file-loading conditions,
IPv4 validation and optional `gcloud` address discovery. AWS retains its own
loader because its fields and host-validation contract differ.
