# Rocento deployment map

These directories deploy and maintain Rocento's own production site and its
four managed demo stores: Grocery, Jewelry, Electronics and Pharmacy. They are
not a client onboarding package.

## Repository areas

| Area | Purpose | Production handling |
| --- | --- | --- |
| `commerce-api/`, `commerce-web/` (including rengine), `commerce-assistant-platform/` | Rocento application and runtime source | Included by the matching deployment workflow |
| `commerce-ops/compose/` | Rocento service definitions | Managed Compose files are uploaded with their services |
| `commerce-ops/deploy/aws-deploy/` | Workstation launchers, public templates and operator guides | Launchers stay on the operator's machine; protected files such as keys and `bootstrap.env` are never uploaded as source |
| `commerce-ops/deploy/ec2/server/` | Canonical EC2 deployment, activation, diagnostics and seed commands | Mirrored to the server; compatibility copies remain under `/opt/rocento/deploy/ec2/server/` |
| `commerce-ops/deploy/ec2/` and managed deployment subfolders | Templates, configuration renderer, and service-specific deployment inputs | Only explicitly managed paths enter production uploads; generated config and secrets stay in server runtime storage |
| `commerce-ops/deploy/gcp-deploy/` | Separate GCP deployment launcher | Independent from the current AWS/EC2 Rocento production workflow |
| `commerce-ops/scripts/` | Shared release gates, deployment helpers, and demo seed tools | Included as runtime support; selected demo seed helpers are transferred by the separate seed launcher |
| `commerce-demo/` | Demo presets and delivery-area seed data | Excluded from normal production source uploads; copied only by the explicit demo seeder |
| `commerce-assets/demo/` | Demo catalog and category images plus seed helpers | Excluded from normal production uploads; selected assets are transferred by the explicit demo seeder |
| `commerce-docs/` | Engineering and operations documentation | Kept in the repository; excluded from application uploads |

## Production and demo boundaries

The normal AWS launcher stages application source and migrations, then the EC2
release gate verifies and promotes the reviewed images and frontend export. It
does not build production artifacts or seed demo data. Its upload boundary is
defined in `ec2/server/ec2-source-filters.sh` and shared with server activation.

Run `aws-deploy/seed-demo.sh` separately when Rocento's demo catalogs, themes,
or delivery coverage need changes. That launcher transfers only the selected
demo data and seeding helpers, then runs them against the existing Rocento
deployment. It does not upload application source, build images, or restart
services.

Within `commerce-ops/scripts/`, `release/` contains the canonical release gates,
`demo/` contains demo seed workflows, and `tests/` contains repository checks.
Top-level compatibility entry points are retained for existing callers; move
or remove them only with their references and `entrypoints.json` mapping updated.

On EC2, `/opt/rocento/deploy/ec2/` remains a protected runtime location for
generated Compose configuration, bootstrap secrets, setup state, and the
deployment lock. Keep it separate from canonical repository source under
`commerce-ops/deploy/`; the server command mirror is retained for existing service
operations.

For the full workflow, see [AWS deployment commands](aws-deploy/README.md) and
[EC2 provisioning](ec2/README.md).
