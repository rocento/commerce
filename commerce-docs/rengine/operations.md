# rengine development and operations

This guide owns configuration, verification, deployment and protected connection storage. Run workstation commands from the repository root unless specified otherwise. See [usage](usage.md) for operator workflows and [tracing rollout](tracing-rollout.md) before deploying capture producers.

## Source and local development

[Service source](../../commerce-web/apps/rengine) is a standalone Node 22.18+ application using only built-in modules. It is part of the frontend pnpm workspace so its browser checks use the shared Playwright dependency. It serves its own UI and calls fixed, operator-configured upstream origins. Browsers cannot supply upstream URLs.

```sh
node commerce-web/apps/rengine/pack-rules.mjs
node commerce-web/apps/rengine/server.mjs
```

Open http://127.0.0.1:3190. `HOST` defaults to loopback, `PORT` to 3190 and `RENGINE_ORIGIN` to that HTTP origin. Configure each demo using `RENGINE_<STORE>_GATEWAY`, `RENGINE_<STORE>_LANGUAGE` and `RENGINE_<STORE>_ASSISTANT`. Names are uppercase, for example `RENGINE_GROCERY_LANGUAGE=http://127.0.0.1:3187`. Local default language ports 3187/3287/3387/3487 and assistant ports 8000–8003 are development placeholders: override them for the services actually running.

The production [Compose service](../../commerce-ops/compose/compose.rengine.yaml) joins the four assistant-private networks, the four commerce networks for gateway access, and its own edge network for host ingress, and binds its HTTP listener only to `127.0.0.1:3190`. It runs unprivileged with a read-only application filesystem and one writable encrypted-connection data directory, memory/CPU/PID limits, no added capabilities and no database credentials. [Nginx](../../commerce-ops/deploy/rengine/nginx.conf) supplies TLS, same-host routing and login throttling.

## Verification

```sh
node --test commerce-web/apps/rengine/tests/*.test.mjs
node --check commerce-web/apps/rengine/public/app.js
bash -n commerce-ops/deploy/aws-deploy/deploy-rengine.sh commerce-ops/deploy/ec2/server/ec2-deploy-rengine.sh
docker compose -f commerce-ops/compose/compose.rengine.yaml config --quiet
# Uses the existing commerce-web Playwright installation and Chromium:
node commerce-web/apps/rengine/tests/browser.mjs
node commerce-web/apps/rengine/tests/sidebar-browser.mjs
```

Automated server tests cover authorization, demo isolation, permission revocation, CSRF, closed upstream requests, statistics, guest credentials and logout. Browser checks cover request/benchmark/trace interactions, the semantic graph, and mobile overflow using synthetic upstream fixtures. CI runs the server and source/configuration checks.

## Production deployment

The Cloudflare record `commerce-rengine` points to the current Rocento host and uses the existing wildcard origin certificate. Deploy from the repository root:

```sh
bash commerce-ops/deploy/aws-deploy/deploy-rengine.sh
```

This uploads only rengine source, its Compose file, its dedicated Nginx site and its deployment script. The server uses the existing deployment lock, preserves the prior image/source/site, builds the service, waits for health, validates Nginx and reloads it. Failure restores the prior service image/site when available. Backups live under `/var/backups/rocento/rengine/`. The dedicated Nginx site survives normal commerce site regeneration. Full uploads also retain rengine source; deploy the service separately after changing it.

On the server:

```sh
cd /opt/rocento
docker compose -f commerce-ops/compose/compose.rengine.yaml ps
docker compose -f commerce-ops/compose/compose.rengine.yaml logs --tail 100
curl --fail http://127.0.0.1:3190/health
```

After deployment, verify HTTPS, unauthorized API rejection, each demo's login/permission boundary, readiness, and a synthetic language request. A healthy rengine process does not establish the health of its upstream demos; the UI checks those separately.

## All-demo smoke check

From the repository root on the workstation, set `RENGINE_SSH_KEY`, `RENGINE_SSH_USER` and `RENGINE_SSH_HOST` for the intended deployment, then run the operator smoke script:

```sh
ssh -i "$RENGINE_SSH_KEY" -o BatchMode=yes "$RENGINE_SSH_USER@$RENGINE_SSH_HOST" \
  'sudo python3 - --journey' < commerce-ops/scripts/checks/check-rengine.py
```

The script reads protected administrator credentials on the server, never prints them, and signs out afterward. It checks each demo’s readiness, a language request, an explicitly scored one-case benchmark, trace-list access and a guest assistant request. The guest request can incur normal provider usage. It performs no authenticated shopper or order mutation.

## Saved connection deployment

The narrow deployment creates `/opt/rocento/deploy/rengine-private/` outside the application source. `operator.env` sets `RENGINE_OWNER_STORE` and `RENGINE_OWNER_EMAIL`; it contains no password. `key` is a 32-byte encryption key, mounted read-only at `/run/secrets/rengine-key`. `data/connections.enc` and `data/connections.enc.sessions` are atomically replaced with mode 0600. The latter stores remembered operator sessions and must be preserved with the matching key across deployments. The data directory and key are owned by container UID 1000; the host parent is root-only. Deployment backups include this protected directory. Restore the data and its matching key together; a missing or incorrect key fails closed. Never commit, print or copy these files into public artifacts. Changing operator identity requires editing the protected environment file and restarting rengine.

Validation: `node --test commerce-web/apps/rengine/tests/*.test.mjs`, `node commerce-web/apps/rengine/tests/browser.mjs`, and `node commerce-web/apps/rengine/tests/connections-browser.mjs`.

The interface uses self-hosted Source Sans 3 with its SIL Open Font License, shared styles in `commerce-web/apps/rengine/public/style.css`, visible current-page/focus state and separate category/result treatments. Preserve keyboard navigation, responsive layouts and local font serving when changing the UI.
