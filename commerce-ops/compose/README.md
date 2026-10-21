# Commerce Compose

This folder contains the main commerce stack's Docker Compose base configuration and optional overlays. Component-specific and onboarding stacks remain next to their owning components.

Run commands from the repository root so `.env` and paths outside this folder resolve consistently:

```sh
[ -f .env ] || cp .env.example .env
bash commerce-ops/scripts/local/local-compose.sh up -d --build --wait
```

Add overlays with more `-f commerce-ops/compose/<overlay>.yaml` arguments. The local wrapper in `commerce-ops/scripts/local/local-compose.sh` supplies the standard base and local resource files; use it for normal local startup.
