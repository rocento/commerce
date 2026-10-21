# Google Cloud deployment

This launcher stages the current checkout on a Compute Engine VM, then invokes
the repository's existing locked activation and production release gate:

```bash
cp commerce-ops/deploy/gcp-deploy/target.env.example commerce-ops/deploy/gcp-deploy/target.env
# Fill target.env, then:
bash commerce-ops/deploy/gcp-deploy/deploy.sh
```

For the VM already created in this session, the target values are project
`project-5824f68c-06bb-42b3-b9a`, zone `europe-west4-a`, instance
`rocento-v1`, and external address `34.7.207.107`. The local private key path
is configured in the ignored local `target.env`; it must match the public key
installed in GCE SSH metadata.

Add the **public** SSH key matching `GCLOUD_SSH_KEY` to the VM or project SSH
metadata with the username `ubuntu`. Keep the private key in its existing
protected local path; never copy it into this repository or the VM. The current
server activation expects the remote account to be `ubuntu`, passwordless sudo,
and `rsync`. `gcloud` CLI login is needed only when `GCLOUD_HOST` is omitted.

## Production prerequisites

This is a transport and activation entry point, not a production-readiness
waiver. Before running it:

- Create `commerce-ops/deploy/gcp-deploy/bootstrap.env` from
  `commerce-ops/deploy/ec2/bootstrap.env.example`, set real domain/admin values and paths
  `/home/ubuntu/.rocento-secrets/rocento-origin.pem` and
  `/home/ubuntu/.rocento-secrets/rocento-origin.key`, then `chmod 600` it.
- Place the matching Cloudflare Origin CA files at `origin.pem` and `origin.key`
  in this directory, both mode 600. Configure DNS and Full (strict) TLS for all
  domains expected by the server deployment.
- Prepare the root-owned `/etc/rocento/release` authorization packet on the VM
  for this exact checkout, machine ID, operation, bootstrap file, and evidence.
  The production gate rejects missing, stale, mismatched, or altered evidence.
- Load the exact reviewed ARM64 application images and frontend artifact on the
  VM. Production deployment does not build or approve release artifacts.
- Provide adequate VM memory and free persistent disk for all services, image
  layers, database volumes, backups, and growth. The server preflight enforces
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
runtime secrets/configuration, and language release state. Take verified backups
and agree on a write freeze, final sync, recovery point, and rollback window.
The existing release readiness packet must include a successful backup/restore
exercise and acceptance against the exact GCP candidate. Do not point any
customer hostname to GCP until those checks pass and all origin checks are green.

After GCP acceptance, cut over the complete Cloudflare hostname set from the
existing AWS address to the GCP address together, keep Cloudflare proxying and
Full (strict) TLS enabled, and monitor the documented health/checkout signals.
Keep AWS and its data intact through the agreed rollback window. The GCP script
does not edit DNS or provide a data-copy operation.

The current service configuration retains its Cloudflare ingress assumptions
and the demo notification mode. Real customer orders require production email
delivery to be configured and reviewed before enabling that flow. Do not treat
a successful VM boot or container health check as production acceptance.

`--dry-run` previews filtered uploads against an existing `/opt/rocento` tree.
It does not upload configuration or run activation. `--preserve-ai` keeps an
existing verified AI release while updating commerce services.

Local files in this directory (`target.env`, `bootstrap.env`, `origin.pem`, and
`origin.key`) are excluded from Git. Do not commit them.
