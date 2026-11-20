# Compose configuration

Compose ownership is organized by role. Run commands from the repository root
and set `--project-directory commerce-ops/compose` whenever selecting files in
these nested folders. That keeps build contexts, bind mounts, and `.env` paths
anchored to the established Compose root.

```text
compose/
├── base/                  # Shared Rocento services and persistent volumes
├── components/            # Optional service definitions and shared runtime settings
└── overlays/
    ├── local/             # Workstation ports, resources, shared networks, and DBeaver
    ├── cloud/              # Shared AI service and rengine runtime topology
    └── demos/              # Store-specific project names and ports
```

Use `python3 commerce-ops/bin/ops local platform up` for the normal local
platform. The [local platform guide](../local/platform/README.md) covers
assistant setup and demo stack entry points.

## Ownership

- `base/` owns common service identities, project defaults, networks, and named
  volumes. Keep optional services and environment-specific changes out of the
  base when possible.
- `components/` owns optional service definitions and reusable service
  topology. Select only the components required by a stack.
- `overlays/local/` owns workstation configuration, including local ports,
  resources, mounts, shared networks, and DBeaver.
- `overlays/cloud/` owns cloud-specific shared services and runtime topology.
- `overlays/demos/` owns store-specific project names and ports.
- Onboarding dependencies stay isolated under `local/onboarding/`.

## Supported compositions

| Stack | Files |
| --- | --- |
| Local platform | `base/compose.yaml` + `overlays/local/compose.local-resources.yaml` |
| Local platform with assistant | Base + local resources + `components/compose.assistant.yaml`, `components/compose.assistant-admin.yaml`, `components/compose.language-engine.yaml`, `components/compose.assistant-runtime.yaml`, and `overlays/local/compose.local.yaml` |
| Local demo store | Base + `overlays/demos/compose.<store>.yaml` + assistant components + `components/compose.shared-ai-consumer.yaml` + local resources |
| Local onboarding | `commerce-ops/local/onboarding/compose.yaml`; a separate project and volumes |
| Cloud Rocento platform | Base + selected components + `deploy/ec2/common.yaml` and store overlay; host topology uses `components/compose.assistant-runtime.yaml` and optionally `components/compose.shared-ai-consumer.yaml` |
| Cloud shared AI | `overlays/cloud/compose.ai-shared.yaml` |
| Cloud rengine | `overlays/cloud/compose.rengine.yaml` |

The [local wrappers](../local/platform/) and host composition command set the
project directory explicitly. The old top-level aliases have been removed; use the canonical nested paths.

A Compose move must preserve project names, service names, named volumes,
networks, published ports, and persistent paths. Resolve the merged config with
synthetic or local values before and after changing file ownership.
