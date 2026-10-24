# Deployment diagnostics

Start with the symptom and target host. The [EC2 operator guide](../deploy/ec2/README.md) documents the host layout and access prerequisites.

## Inspect the current installation

On the deployment host, use the canonical read-only status and doctor commands:

```bash
sudo bash /opt/rocento/commerce-ops/cloud/host/status.sh
sudo bash /opt/rocento/commerce-ops/cloud/host/doctor.sh
```

From a workstation with a configured named target and SSH host key, use
`python3 commerce-ops/bin/ops cloud status --target production-aws` or
`cloud doctor` through the same dispatcher. `cloud logs` requires an explicit
store and service name. See the [command interface](../COMMANDS.md).

These commands inspect the current installation and require the protected host setup. Record the command output, failing service, and installation identity before changing anything. For a specific application failure, follow the relevant service logs from the [EC2 operator guide](../deploy/ec2/README.md).

If the diagnosis points to a deployment input or release candidate, return to [release preparation](release-preparation.md) or [platform deployment](rocento-platform-deployment.md) after correcting the cause.

## SSH upload timeout

The local deploy script gives SSH, rsync and scp a 20-second connection timeout,
up to three connection attempts, and keepalive probes every 15 seconds. These
settings help transient connection failures; they cannot open a blocked port.
A failure during source upload stops the script before remote activation.
Rerun from the same local checkout when SSH is reachable. Load the same
target file as the launcher before the connection check:

```sh
bash -c 'source commerce-ops/cloud/providers/aws/target.sh; load_aws_target; exec ssh -i .local/commerce-ops/secrets/aws/rocento.pem -o BatchMode=yes -o ConnectTimeout=10 "ubuntu@$AWS_HOST" true'
bash commerce-ops/cloud/providers/aws/deploy.sh
```

If SSH still times out, confirm that the instance is running, its public IP is
still the configured address, and its security group permits TCP 22 from your
current public IP. Also check local VPN/firewall connectivity. Keep this access
restricted to your IP. Connection retries do not retry the remote deployment
command after it has started.

The launcher also shares one authenticated SSH connection across its commands
and uploads. Network-interrupted rsync/scp transfers are retried at most three
times; rsync retains partial files for resumption. Non-network transfer errors
fail immediately. Errors identify the deployment stage. The remote deployment or
seed command is never automatically retried, since it may already have changed
services or data.

A timeout during the initial SSH connection occurs before
source upload. Demo seeding is never part of this launcher; run the standalone
EC2 seed command separately after a successful deployment.

## Historical repair: gateway migration VersionMismatch

A successful image build and agentic contract preflight do not compare SQLx
migration contents against the deployed database. If the gateway exits with
`VersionMismatch(20260922120000)`, the capacity migration was edited after
being applied. The three EC2 stores' original migration was recovered and
verified against their recorded SHA-384 checksum on 22 September 2026.

The repair restores `20260922120000_fulfillment_capacity.sql` exactly and adds
`20260922121000_fulfillment_capacity_extensions.sql` for settings, overrides,
reservation timezone backfill, historical address retention and indexes.
Existing reservations take their schedule's timezone; capacity defaults off.
Do not modify `_sqlx_migrations`, reset databases or remove volumes to bypass
this error. Redeploy from the repaired checkout:

```sh
bash commerce-ops/cloud/providers/aws/deploy.sh
```

The launcher now includes the gateway's recent log when Compose startup fails.
The repair was checked on disposable PostgreSQL for both an upgrade with an
existing reservation and a fresh installation through all 55 current migrations.
Reproduce that check with `python3 commerce-ops/tools/checks/check-capacity-migration-upgrade.py`;
`python3 -m unittest discover -s commerce-ops/tests/operations -p test_capacity_migration_history.py` protects the
original migration checksum. These local checks do not establish EC2 recovery;
a successful deployment and its readiness checks establish that separately.

Earlier isolated M10 snapshots containing the edited original migration retain
their historical source/checksum. They are not silently reconciled by this fix;
keep their evidence intact and use a fresh disposable database for a new rehearsal.

## Historical repair: duplicate migration version

On 22 September 2026, the server retained the obsolete
`20260922150000_fulfillment_plans.sql` alongside the current
`20260922150000_market_commerce.sql` and
`20260922160000_fulfillment_plans.sql`. The general source upload had preserved
files removed or renamed locally. SQLx applied market commerce, then the
second migration at that version failed with a duplicate history key;
subsequent startup reported a version mismatch against the stale file.
The successfully applied market-commerce checksum matches the current source.

The deployment launcher now excludes migrations from the general upload,
and mirrors only
`commerce-api/rocento-api/migrations/` with deletion of obsolete source files. This affects no
Docker volume or database record.

Before building or replacing any application containers, `ec2-up.sh` now
rejects duplicate migration versions and compares all applied migration
checksums for all three existing stores. Missing, changed or unsuccessful
applied migrations stop deployment. A new PostgreSQL installation without
migration history is handled separately. `commerce-ops/tools/checks/check-migration-history.py`
also runs standalone for local inventory checks or a saved read-only history.

Use the normal `bash commerce-ops/cloud/providers/aws/deploy.sh` command from this updated checkout.
Do not delete migration history or manually retry an already applied SQL file.
