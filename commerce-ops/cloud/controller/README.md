# Merchant fleet controller

This directory owns central merchant provisioning orchestration. It runs on the
onboarding controller with protected database, provider, DNS, Terraform and SSH
configuration. Workstation deployment adapters remain under `cloud/providers/`;
merchant VM execution and bootstrap remain under [cloud/host](../host/README.md).

## Ownership and installation

| Source | Responsibility | Installed location |
| --- | --- | --- |
| `merchant_fleet.py` | Reconcile database-owned placement, authorize creation and coordinate pinned remote execution | `/usr/local/lib/rocento/merchant_fleet.py` |
| `fleet_providers.py` | Read-only provider identity discovery and bounded HTTP transport | `/usr/local/lib/rocento/fleet_providers.py` |
| `fleet_terraform.py`, `merchant-terraform/` | Saved creation-only plans, per-host state and pinned provider modules | `/usr/local/lib/rocento/fleet_terraform.py`, sibling `merchant-terraform/` |
| `fleet_release.py` | Verify immutable release pins, download bundles and transfer them to the bootstrap endpoint | `/usr/local/lib/rocento/fleet_release.py` |

The [worker installer](../../services/onboarding/install-merchant-worker.sh)
installs these files together with the host-side modules needed to verify and
coordinate execution. Installed filenames, systemd units, configuration paths
and state locations remain unchanged. Source imports resolve within this
directory; installed imports resolve within `/usr/local/lib/rocento`.

Inputs are reviewed release pins, explicit provider profiles, protected credential
files and current database authorization. Effects include cloud VM creation,
release transfer, DNS updates and provisioning checkpoints. Follow the
[onboarding fleet procedure](../../services/onboarding/README.md#merchant-fleet-aws-google-cloud-and-hetzner)
for configuration, recovery and acceptance. Imports and offline tests do not
create infrastructure.

## Package boundary and verification

Normal platform source uploads exclude this directory. Merchant node bundles use
the explicit source list in
[package-merchant-release.py](../../services/onboarding/package-merchant-release.py);
they contain host execution dependencies, not controller modules or credentials.
The bootstrap receiver is host code even though the controller embeds it in
cloud-init. Do not move it here solely because the controller distributes it.

Run the fleet, candidate and packaging suites described in the
[operations test guide](../../tests/operations/README.md). Packaging tests load
installed filenames outside the checkout and verify the node dependency set.
Terraform module bytes and provider locks remain unchanged by the source move;
the existing mock-provider plans use the new source directory.
