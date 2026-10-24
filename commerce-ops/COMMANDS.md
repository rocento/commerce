# Commerce operations command interface

From the repository root, run `python3 commerce-ops/bin/ops help`. The dispatcher also works from another directory when invoked by absolute path. `python3 commerce-ops/bin/ops catalog` lists the public commands, effects, and owning runbooks from [commands.json](commands.json). The dispatcher runs the existing scripts; their direct paths remain supported during the folder migration. The catalog separately names known imported helpers. `config/entrypoints.json` remains a broad source inventory and is not an operator menu.

## Common tasks

| Task | Command | Effect |
| --- | --- | --- |
| Start local platform | `python3 commerce-ops/bin/ops local platform up` | Starts the existing `commerce-ai` Compose project |
| Inspect local platform | `python3 commerce-ops/bin/ops local platform status` | Reads Compose state |
| Start local onboarding dependencies | `python3 commerce-ops/bin/ops local onboarding up` | Starts isolated `rocento-control-local` Compose project |
| Set up local assistant storage | `python3 commerce-ops/bin/ops local assistant setup` | Writes local credentials and database state |
| Preview a demo preset | `python3 commerce-ops/bin/ops local demo seed --store grocery` | Prints the preset; no API write |
| Initialize release packet | `python3 commerce-ops/bin/ops release prepare --candidate "$CANDIDATE_SHA" --packet commerce-output/release/packet.json --environment production --owner "$RELEASE_OWNER"` | Creates a packet; it does not qualify the candidate |
| Check release packet | `python3 commerce-ops/bin/ops release check --candidate "$CANDIDATE_SHA" --packet commerce-output/release/packet.json --environment production` | Reads packet and linked evidence |
| Outline a cloud deployment | `python3 commerce-ops/bin/ops cloud plan --target production-aws --candidate "$CANDIDATE_SHA" --packet commerce-output/release/packet.json` | Reads local target and packet path; no SSH or writes |
| Deploy platform | `python3 commerce-ops/bin/ops cloud deploy --target production-aws` | Uploads and starts the existing host activation gate |
| Inspect deployed platform | `python3 commerce-ops/bin/ops cloud status --target production-aws` | Executes the installed read-only status command over SSH |
| Inspect service logs | `python3 commerce-ops/bin/ops cloud logs --target production-aws --store grocery --service api-gateway` | Reads bounded host logs |
| Seed a production demo | `python3 commerce-ops/bin/ops cloud demo seed --target production-aws --store grocery` | Changes demo data through the selected provider launcher |

`local platform` and `local onboarding` also accept `down`, `status`, and `logs`. `local platform` accepts `--assistant`. Local demo writes require both `--apply` and `--api-base` with `localhost` or `127.0.0.1`; the underlying seed command still enforces its credentials and isolation checks. Cloud diagnostics include `doctor`. Cloud demo seeding uses the same host workflow through AWS or GCP target launchers.

## Named targets and precedence

Every cloud command requires `--target`; no cloud host is selected by default. Target names use lowercase letters, digits, and hyphens. A named target lives in ignored `.local/commerce-ops/targets/<name>.env` and uses plain `KEY=value` lines. The parser does not execute the file. It rejects unknown keys, duplicate keys, malformed lines, symlinked target files, unsupported providers, and SSH users other than `ubuntu`.

Copy a safe template from [config/examples](config/examples/production-aws.env). Supported fields are `PROVIDER=aws|gcp`, `HOST`, `SSH_USER=ubuntu`, and, for GCP, `SSH_KEY`, `PROJECT`, `ZONE`, `INSTANCE`. GCP `HOST` must be the VM's direct-origin IPv4 address. A relative GCP key path is resolved from the repository root. AWS uses `.local/commerce-ops/secrets/aws/rocento.pem`; `SSH_KEY` is not accepted for AWS targets.

The migrated `production-aws` and `production-gcp` target files live at `.local/commerce-ops/targets/production-aws.env` and `production-gcp.env`. Provider credentials and bootstrap/TLS files live under `.local/commerce-ops/secrets/aws/` and `secrets/gcp/`. Keep those directories private; moved files retain their local permissions. Custom target names require a matching named file. For the host, precedence is `--host`, then `ROCENTO_AWS_HOST` or `GCLOUD_HOST`, then the selected file. For the GCP key and project labels, scoped `GCLOUD_*` environment variables override the selected file. The dispatcher passes the resolved values to the existing provider launcher through its established environment variables.

Cloud writes print operation, named target, provider, host, and scope before execution. The launcher still checks its protected bootstrap/TLS inputs and the host release gate. `cloud plan` is offline and reports the candidate SHA, evidence packet path, source filter, and upload categories; it does not check release readiness, enumerate every rsync item, contact SSH, export data, or activate anything. Run the release check separately and follow the [release readiness procedure](../commerce-docs/platform/operations/release-readiness.md).

Cloud `status`, `doctor`, and `logs` require an existing SSH host-key entry and execute the installed `/opt/rocento/deploy/ec2/server/` commands. They do not modify the deployment. The current provider launchers still own host access and source transfer. The new interface does not provision a VM, DNS, IAM, or certificates.

## Boundaries

Local platform commands never take a cloud target. Onboarding commands start only local dependencies; API migrations and application startup remain in the [onboarding guide](tasks/onboarding.md). Release packet preparation, platform deployment, and demo data seeding are separate actions. This interface contains no staging-server, backup, restore, or deployment-rollback command.

## Validation status

The interface was exercised by earlier offline fixtures, but those results apply
to their original batches. Later host and shared AWS/GCP seed changes have
received static checks; focused behavior verification remains in the
[current refactor priorities](REFACTOR-PLAN.md#current-progress-and-next-priorities).
Maintain validation history in that plan, not in this operator reference.
