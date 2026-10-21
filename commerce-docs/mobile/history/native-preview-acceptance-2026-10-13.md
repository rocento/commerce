# Local iOS native preview acceptance — 2026-10-13

Historical checkpoint. Later records may supersede these deployment statements; see the [mobile status](../../frontend/README.md) and [history index](README.md).

Historical evidence; current behavior is documented in the [native preview specification](../native-preview.md).

## Verification evidence

The dedicated `Rocento Native Sync QA` simulator (`4602004B-7525-4DEF-89B3-5C4821262D0C`, iOS 26.2) ran the signed `com.rocento.grocery` Studio app. The real builder changed theme and section content; the same running native app acknowledged revisions **7 → 8 → 9 → 10**, including an injected HTTP outage and recovery. Screenshots were inspected: the last valid text stayed visible while offline, and the recovered text appeared afterward. No app rebuild occurred between edits.

- [Machine-readable acceptance result](../../platform/evidence/README.md#evidence-62ba9d1276cff90a) (`output/native-preview-20261013/result.json`)
- [Native view after recovery](../../platform/evidence/README.md#evidence-deac4baa08270062) (`output/native-preview-20261013/native-recovered.png`)
- [Native view during outage](../../platform/evidence/README.md#evidence-4ac2bd3ac933c8b1) (`output/native-preview-20261013/native-offline.png`)
- [Builder acknowledgement](../../platform/evidence/README.md#evidence-b6a7f2d76a8fae3b) (`output/native-preview-20261013/builder-after.png`)
- [Signed Studio identity check](../../platform/evidence/README.md#evidence-1c8c7d053b350844) (`output/native-preview-20261013/studio-signing-check.json`)

Checks passed: 17 Swift adapter tests, 113 isolated core tests, 65 mobile tooling tests, the 15-test mobile API regression suite (serial execution avoids the existing password-hasher concurrency budget), both preview-session security tests, TypeScript, the Vite production build, Rust architecture and standalone binary isolation. Signed standalone and Studio builds passed. The deployment ingress allowlist test passed; its Docker Nginx variants were not run.

Failures recorded at that historical checkpoint (see the cleanup audit for results at the later cleanup checkpoint): the browser preview suite has 23/24 passing tests, with its old `ms-native-header-brand` expectation no longer matching the current header; the API audience inventory rejects eight previously unclassified catalog-preview, delivery-fee and push-device operations. The six new session operations are classified and present in generated OpenAPI. No existing failure or architecture guard was suppressed.

This is local acceptance with synthetic configuration and a disposable database. No production backend migration, deployment, remotely hosted simulator or browser video stream was performed. Signing identity was checked against the installed baseline; existing customer login restoration was not independently exercised by this design-sync test.
