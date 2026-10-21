# Tracing rollout verification

This runbook owns capture-v2 canary and recovery gates. Reviewed on 2026-10-14 against source and recorded evidence; no live checks were made during this documentation refactor.

The last recorded production state on **2026-10-11** is partial: compatible gateway/rengine readers and lighter health probes were deployed, while the Python/language producer was rolled back after repeated latency-gate failures. The revision-12 retry remains blocked. See [the full canary and rollback record](history/tracing-rollout-2026-10-14.md) for measurements, exact identities and protected backup locations. Those identities are historical, so inspect the active release before any new activation.

## Supported evidence

| Boundary | Recorded by the v2 implementation | Remaining gap |
| --- | --- | --- |
| Gateway → Python | Gateway dispatch identity and root Python parent link | Admission duration, gateway stream completion, browser delivery |
| Python → language engine | Python transport interval and matching remote handler UUID/duration | Cross-service clock alignment |
| Python → catalog gateway | Actual fetch interval and signed-request-scoped remote handler on successful responses | Error-handler durations; cache/coalesced waiter work is not invented |
| Python → provider | Attempt identity, parent, dispatch time, validated usage and result | Provider internals and remote clock |
| Other commerce tools, embeddings, databases | Existing evidence only | No new propagation |

These are capability and report-version statements, not a claim that production has accepted the new producer. The protocol is internal and versioned, without W3C/OTel interoperability. See [the evidence contract](tracing-evidence-contract.md).

## Before deployment

- Inspect the intended store's current gateway, rengine, Python, language, image and immutable release identities. Preserve a compatible rollback baseline and settings under the deployment lock.
- Ensure readers accept v1/v2 before enabling a v2 producer. Use a frozen candidate matching the active knowledge baseline and packaged recognition rules; never substitute temporary fixture data for a deployed release.
- Resolve the remaining [producer performance work](tracing-improvement-plan.md) before retrying. The previous dictionary-fixture mismatch was resolved for the recorded canary, but every new combined candidate needs fresh verification.
- Select one demo, an authorized operator and a synthetic request that performs language resolution and a catalog read. Plan warmups, alternating capture modes, sample size and quota headroom before measurement. Keep production credentials/customer payloads outside public artifacts.

## One-demo sequence

1. Deploy compatible gateway/rengine readers first, following [rengine operations](operations.md#production-deployment). Deploy the candidate language trace responder and Python producer only after matching-release checks and recovery preparation pass. The tracing headers need no new database migration.
2. Verify the installed language release against Python's packaged fingerprint/runtime pin. Preserve knowledge data and unrelated deployment settings.
3. Enable detailed capture through existing authorized settings. Run the representative request. Inspect current Execution timeline cards, recorded service/parent links, section navigation and raw evidence. HTTP handler success does not establish shopping fulfillment.
4. Export the report through the audited action. From the repository root validate the redacted file:

   ```sh
   node commerce-ops/scripts/checks/check-trace-rollout.mjs /absolute/path/to/redacted-export.json
   ```

   The checker requires complete v2 terminal evidence and gateway→Python plus language/catalog remote-handler links with valid independent clocks. A request that skipped one of those boundaries does not satisfy this canary. It prints counts/errors rather than report payloads.
5. Verify legacy reads, refresh/deep links, live start/completion identity, tenant isolation, read/export permissions and redaction. Malformed or absent headers must not change business behavior.
6. Turn capture off and repeat the request. No new detailed report or downstream Python trace context should be produced. Existing telemetry and the gateway's small dispatch identifier are independent of this switch.
7. Compare capture-on/off full-stream EOF p95 with the unchanged limit: `max(off × 1.25, off + 100 ms)`. Retain `doneMs` and `postDoneMs` to diagnose the boundary. Check event/byte pressure and concurrent work without silently changing the agreed workload or acceptance gate.
8. Preserve all results and approve the completed canary evidence before applying the validated candidate to remaining demos. Reader health, functional export validation and producer latency are separate acceptance results.

## Recovery

Disable detailed capture through its existing setting if overhead or evidence quality fails. Restore the matching prior producer images/language responder as necessary while retaining compatible readers, so saved v1/v2 reports remain accessible. Preserve new customer writes, knowledge release state and historical reports. Restore settings and recheck normal assistant behavior, capture-off mode and every affected consumer.

Do not run dated rollback scripts against a later release: the previous revision-4 and pre-revision-12 identities are obsolete. Use the candidate's freshly reviewed guards and recovery manifest. Repeated unchanged retries or a weaker gate do not resolve the recorded failure.

The synthetic fixture at `commerce-web/apps/rengine/tests/fixtures/trace-services.json` demonstrates reader/checker behavior only. Production evidence and previous performance measurements are indexed in [history](history/README.md); local fixtures and historical results cannot certify a new rollout.
