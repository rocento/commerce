# rengine documentation

rengine is the separate shopping-assistant diagnostics service at [rengine.rocento.com](https://rengine.rocento.com). It connects to grocery, jewelry, electronics and pharmacy through their authorized gateway APIs. This section owns its usage, operations and tracing contract.

| Guide | Purpose |
| --- | --- |
| [Using rengine](usage.md) | Sign-in, workspaces, current trace navigation and evidence limits |
| [Development and operations](operations.md) | Local configuration, verification, deployment and protected connection storage |
| [Tracing evidence contract](tracing-evidence-contract.md) | Versioned capture fields, clocks, parent links and privacy boundaries |
| [Tracing improvement plan](tracing-improvement-plan.md) | Remaining producer performance work and acceptance gates |
| [Tracing rollout](tracing-rollout.md) | Current deployment sequence, canary requirements and rollback boundaries |
| [History](history/README.md) | Dated UI, implementation and production evidence |

Documentation reviewed against source on **2026-10-14**. The current source opens message details on **Execution timeline**, using cards with details below; older Waterfall links normalize to that view. This source review does not establish which UI build is currently deployed.

The last recorded production result, **2026-10-11**, has compatible gateway/rengine readers and lighter health probes deployed. The capture-v2 Python/language producer failed its latency gate and was rolled back; production rollout remains blocked. Existing v1 reports and retained v2 canary reports remain readable. See [rollout status and limits](tracing-rollout.md).

Deploying rengine alone does not restart commerce or AI services. Producer changes require their own validated assistant release; implementation, local checks, deployment and production acceptance must be tracked separately.
