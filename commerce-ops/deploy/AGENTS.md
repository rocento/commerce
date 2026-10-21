# Deployment agent guide

Read [EC2 deployment](ec2/README.md) and the
[platform guide](../../commerce-docs/platform/README.md) before changing packaging
or lifecycle behavior. Native preview has a separate [service guide](native-preview/README.md).

## Ownership and boundaries

- `aws-deploy/` owns workstation launchers, guides and public templates;
  `ec2/server/` owns commands executed on the deployment host. Call server commands directly from `ec2/server/`.
- `ec2/` owns renderer code, server templates and protected generated state.
  Private workstation settings and keys live in `aws-deploy/`; preserve their
  permissions, Git exclusions and exclusion from source uploads.
- `aws-automation/` owns Android instance/session lifecycle control;
  `native-preview/` owns worker and gateway tooling. Preserve installed runtime
  paths, systemd names and the distinction between repeatable installation and
  a one-time rollout.
- Keep the sibling `../compose/` path and Compose project identity stable. Build
  contexts, bind mounts, volumes, source activation and deployment locks depend
  on them.
- Update explicit partial-upload lists and source filters with each move.
  Include canonical implementations required by wrappers; exclude private
  settings, generated state and workstation-only launcher code as appropriate.

## Verification

Use the affected `commerce-ops/scripts/tests/test_*deployment*.py`, transport and source-filter
tests, plus `bash -n` for modified shell scripts. Native controller tests use
mocked AWS calls. Check command discovery and packaging from another working
directory as well as the repository root.

Inspect fixture side effects before running tests. Repository refactoring is
verified locally; production deployment and acceptance are separate operations.
