# Deployment agent guide

Compatibility boundary: do not add new command implementations here. Use the
canonical `local/`, `cloud/`, `services/`, `workflows/` or `tools/` owner.
Retained historical harnesses, installed adapters and deployment assets keep
their documented ownership until their consumers migrate.

Read [EC2 deployment](ec2/README.md) and the
[platform guide](../../commerce-docs/platform/README.md) before changing packaging
or lifecycle behavior. Native preview has a separate [service guide](../services/native-preview/README.md).

## Ownership and boundaries

- `../cloud/providers/aws/` and `../cloud/providers/gcp/` own the canonical
  workstation launchers and guides. `aws-deploy/` and `gcp-deploy/` retain local
  private configuration during migration. `../cloud/host/` owns canonical
  implementations executed by both providers. `ec2/server/` retains established
  source and installed compatibility paths while callers migrate.
- AWS workstation commands read `.local/commerce-ops/targets/production-aws.env`
  through `../cloud/providers/aws/target.sh`. Secrets are under
  `.local/commerce-ops/secrets/aws/`. Keep target parsing in that helper and update every
  launcher when changing its interface.
- The provider launchers share workstation SSH/rsync setup, transfer retry,
  and connection cleanup in `../cloud/lib/transport.sh`. Keep remote activation outside this
  helper; a transfer can be retried, but a launched deployment must only be
  monitored.
- `../cloud/lib/jobs.sh` owns private stage creation, managed source transfer,
  and monitoring. Preserve the AWS `--copy-dest` and GCP direct transfer
  strategies, and keep protected configuration upload provider-specific.
- `../cloud/lib/source-filters.sh` owns the managed source boundary for workstation
  uploads, release inventory, and host activation. The old `shared/source-filters.sh`
  path is a compatibility link; `ec2/server/` contains a wrapper.
- `../cloud/host/` owns host configuration renderers. `ec2/` keeps the legacy
  source alias, server templates and protected generated state until the
  remaining host sources move.
  Service implementations and their installation assets belong in
  `../services/<service>/`; keep provider-neutral runtime code out of `deploy/`.
  Private workstation settings live under `.local/commerce-ops/targets/` and
  `.local/commerce-ops/secrets/`; preserve permissions and keep them excluded
  from Git and source uploads.
- `../services/native-preview/aws-controller/` owns Android instance/session
  lifecycle control; `../services/native-preview/` owns worker tooling.
  The former deploy directories are source compatibility symlinks. Preserve installed runtime
  paths, systemd names and repeatable installation.
- Keep the sibling `../compose/` path and Compose project identity stable. Build
  contexts, bind mounts, volumes, source activation and deployment locks depend
  on them.
- Update explicit partial-upload lists and source filters with each move.
  Include canonical implementations required by wrappers; exclude private
  settings, generated state and workstation-only launcher code as appropriate.

## Verification

Use the affected `commerce-ops/tests/operations/test_*deployment*.py`, transport and source-filter
tests, plus `bash -n` for modified shell scripts. Native controller tests use
mocked AWS calls. Check command discovery and packaging from another working
directory as well as the repository root.

Inspect fixture side effects before running tests. Repository refactoring is
verified locally; production deployment and acceptance are separate operations.
