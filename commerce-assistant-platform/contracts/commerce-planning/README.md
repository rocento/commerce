# Executable planning v1

M05 adds execution-rich definitions alongside the frozen M03 compatibility DTOs. `ExecutableSkill` derives the existing `SkillDefinition`, retaining its risk, confirmation, version, timeout and scope invariants. `Procedure`, `PlannedNode`, `PlanningBudget` and `BoundPlan` describe executable bounded workflows; M03's minimal `ExecutionPlan` remains its original compatibility wire contract. M04 constraints and policy decisions are reused directly.

The canonical seeded library is `commerce-assistant-platform/app/planning_library.json`. It is data only. New procedures use pinned existing skills and do not import clients. The composition root binds logical input/output contract references to the existing operation DTOs. Basket context and quote wrappers expose narrow typed receipts; Rust remains authoritative for the full context, draft and proposal transport and all commerce validation.

Generate using `commerce-assistant-platform/.venv/bin/python commerce-ops/scripts/contracts/generate_planning_contracts.py`; `--check` detects drift. Shared Python/Rust/TypeScript fixtures validate wire shape. Python additionally enforces registry membership, schema bindings, DAG order, immutable mandatory dependencies, aggregate skill-call limits, context/scopes, hard contradictions, policy/risk bindings and resource admission. Wire acceptance is not an execution credential.

Budget spend is denominated in USD micros. Skill ceilings bound admission; runtime model calls reserve a conservative UTF-8 byte/token bound plus schema/framing headroom and maximum output, using positive operator-supplied rates pinned to the selected model. Unknown/mismatched pricing, excess tokens and excess estimated spend stop before the provider call. Failed-call reservations are retained. Provider billing remains authoritative; rates must be reviewed when the model or pricing changes.

Runtime operations are serial, bounded by the shared deadline, and never replay through legacy after execution starts. Defaults allow zero commerce mutations. External `rust_ui` skills describe existing owned-order selection/rebuild and approved cart application; registering them does not expose them as model-callable tools. Buy Again's direct UI → Rust flow remains intact. Durable execution/restart/replanning belongs to M06.

Grocery and Jewelry pack rules intersect the actual returned schema; the initial evaluated attributes are recorded in the library. Pharmacy/skincare/electronics remain schema-ready and carry no new quality or regulatory-acceptance claim. Arabic remains deferred.


The additive private gateway example `v1/compound-dispatch.json` is shared by the Python compound-command and Rust gateway tests. Its canonical Python contract is `app/commerce_action_engine/contracts/compound_write.py`; Rust validates its bounded shape in `assistant_compound.rs`. It contains no authorization token. This example does not alter the existing planning schema or authorize the non-executing M3 review plan. See `../../../commerce-docs/platform/reports/shopping-assistant-receipts-m4a.md` for receipt behavior and remaining execution admission work.
