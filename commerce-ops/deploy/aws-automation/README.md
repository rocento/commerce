# Native preview EC2 controller

This folder owns the Android EC2 lifecycle controller, service installer, IAM policies, proxy snippets, and mocked tests. The native emulator worker remains in the [native preview folder](../native-preview/README.md).

Live deployment: `apps-android-ec2-20261014`. See the [dated acceptance report](../../../commerce-docs/mobile/history/android-ec2-preview-acceptance-2026-10-14.md).

## Operation

In App Studio, select Grocery → Native Preview → Android. Owners can start the server; wait for Ready, then open a preview. Stop the preview and wait for cleanup before stopping the server. EC2 automatically stops after five minutes with no active previews, including after expired previews finish cleanup. EBS and Elastic IP costs remain while stopped.

Only one native emulator is configured. Fresh emulator boot takes about 90 seconds and the screenshot stream is approximately 2 fps. iOS is not connected to this Linux worker.

## Boundaries

- Main host `i-02c1e79a38687db82` uses approved IAM role `RocentoAndroidPreviewControl`; exact policies are beside this file.
- Fixed Android worker `i-0af639278db7286a9` in `eu-central-1`; user requests cannot select another instance.
- `rocento-mobile-preview-gateway` listens on main-host loopback 9085. It uses existing admin identity/CSRF checks and owner authorization for lifecycle changes, with audit events.
- `rocento-android-controller.service` listens on loopback 19097, uses IMDS credentials, and authenticates gateway requests using a root-only shared bearer secret.
- `rocento-android-tunnel.service` forwards main loopback 19096 to the private worker. The dedicated SSH key is source-restricted, forwarding-only, and may reach only worker loopback 19096. Host identity is pinned.
- Worker service is `rocento-android-preview.service`. ADB and emulator ports are loopback-only. Preview capabilities never enter the browser or process command lines.
- The controller checks every 10 seconds. Active previews, unavailable worker health, and non-running EC2 states reset the idle countdown. A controller restart begins a fresh five-minute timer.
- Stop fails closed unless the worker confirms zero active devices; new-session acceptance is serialized with shutdown checks.

## Maintenance and rollback

Secrets live only on the hosts: `/opt/rocento-preview-control/{controller,gateway}.env` and `/etc/rocento-android-preview.env`. Never copy their contents into reports or logs.

Nginx uses `rocento-native-preview-{apps,grocery}.conf` snippets. The repository EC2 renderer retains optional wildcard includes. New main frontend builds must set `VITE_ANDROID_EC2_ENABLED=true VITE_IOS_PREVIEW_ENABLED=false` to retain these controls.

`activate.py` is a one-time guarded rollout, not an idempotent installer. It uses the deployment lock and backs up config, frontend pointer, and mobile schema. The server backup is `/var/backups/rocento/apps-android-ec2-20261014`. The migration-compatible rollback image is `rocento-apps:rollback-20261014`; do not restart the older gateway image against new recorded SQLx migrations. Review deployment metadata before applying any rollback. Keep the private controller/tunnel and preview image backed up when maintaining the main deployment.


## API

The service entry point is `controller.py`. It listens on `127.0.0.1:19097`. All endpoints require `Authorization: Bearer <MOBILE_ANDROID_PREVIEW_WORKER_TOKEN>` from the trusted gateway. AWS access uses the host instance role.

| Method | Internal endpoint | Purpose |
| --- | --- | --- |
| GET | `/instance` | Read EC2 state, worker readiness, and active preview count |
| POST | `/instance/start` | Start the configured Android instance; empty body |
| POST | `/instance/stop` | Stop only after the worker confirms all previews are cleaned up; empty body |
| POST | `/sessions/{id}` | Create a native preview through the private worker |
| GET | `/sessions/{id}` | Read the latest preview frame |
| DELETE | `/sessions/{id}` | Stop a native preview |
| GET | `/sessions/{id}/video` | Stream native frames |
| POST | `/sessions/{id}/input` | Forward interactive input |

Lifecycle responses contain `state`, `ready`, and `activeSessions` (nullable when the worker is unavailable), for example:

```json
{"state":"running","ready":true,"activeSessions":0}
```

Invalid authentication returns 401; conflicting lifecycle actions return 409; unavailable upstream services return 503. The instance ID is operator configuration, never a request parameter. The session request contracts are defined by the native worker in `commerce-ops/deploy/native-preview/worker.py`.

App Studio continues to use its existing public routes:

- `GET /api/v1/merchants/{merchantId}/app-preview/instance`
- `POST /api/v1/merchants/{merchantId}/app-preview/instance` with `{"action":"start"}` or `{"action":"stop"}`

The thin Rust adapter in `commerce-api/rocento-api/crates/api-gateway/src/mobile/preview_ec2.rs` retains merchant authorization, owner checks, CSRF protection, and audit records, then calls this separate service. Browser clients never receive the internal bearer token or AWS credentials.

## Run and test

From the project root:

```sh
python3 -m venv commerce-ops/deploy/aws-automation/.venv
commerce-ops/deploy/aws-automation/.venv/bin/pip install -r commerce-ops/deploy/aws-automation/requirements.txt
# Set AWS_REGION, ANDROID_EC2_INSTANCE_ID and MOBILE_ANDROID_PREVIEW_WORKER_TOKEN
# through the deployment environment; see .env.example for variable names.
commerce-ops/deploy/aws-automation/.venv/bin/python commerce-ops/deploy/aws-automation/controller.py
```

The example environment file is documentation; the process does not load dotenv files automatically. Use the deployment environment or systemd EnvironmentFile.

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s commerce-ops/deploy/aws-automation -p 'test_*.py'
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s commerce-ops/scripts/tests -p 'test_native_preview_layout.py'
```

Tests mock AWS and do not start or stop an actual instance. The layout tests also exercise the service installer against temporary paths and a fake systemd command.

`install-services.sh` is the repeatable controller/tunnel service installer. Upload this folder together: it resolves `controller.py` beside the installer, independently of the working directory. On the intended host it requires root, the existing `/opt/rocento-preview-control` directory, its root-only `controller.env` and tunnel key, and the existing `venv` with `requirements.txt` installed. It does not create credentials or rebuild that environment. It copies the controller and writes the existing service definitions and pinned host identity, then enables and starts the two services. Updating a controller that is already running requires the operator's normal service restart procedure. Existing server runtime paths remain `/opt/rocento-preview-control`.

The old `commerce-ops/deploy/aws-automation` executable entry points and requirements file forward here in a complete checkout. They are compatibility launchers; upload this canonical folder for standalone host installation. The dated `activate.py` remains a separate one-time guarded rollout and is never called by the repeatable service installer.

## Deployment verification — 2026-10-14

At the time of this historical verification, the source folder was deployed to `/opt/rocento/deploy/aws-automation` on the demo EC2 and restarted the controller from the matching runtime copy. Backups: `/var/backups/rocento/deploy/aws-automation-20261014T013248Z`. All five controller tests passed on the server. Live website Stop/Start and automatic private worker reconnection passed; a fresh preview streamed at 1–2 fps. Browser tap and keyboard input produced `milk` in the native search field. A reversible theme change was acknowledged as r62, and the original theme was restored and acknowledged as r63. Published release remained v6. Evidence is in `output/deploy/aws-automation-20261014/`.

After testing, the preview was revoked and AWS Console confirmed the Android instance **Stopped**.

Five-minute automatic idle shutdown was deployed on 2026-10-14. Boundary and activity/health reset tests passed on EC2. During live observation a preview became active, so the controller preserved it and reset the countdown. An uninterrupted five-minute live idle shutdown was not observed in this run. Evidence: `output/deploy/aws-automation-20261014/auto-stop.json`.
