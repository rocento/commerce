# Mobile experience contract

The mobile runtime and native build manifests have separate versioned contracts. The canonical files live inside the API build context so local and Docker gateway builds validate exactly the same schema.

Swift, Kotlin and React Native applications must never depend on the Rocento Apps Builder editor implementation. For app definitions and rendering, they depend only on these versioned contracts, native runtime components and authorized configuration delivery. The editor consumes and produces the contract; its source, UI, state and internal models are not runtime dependencies. Shared types and generated models must come from the canonical contract, independently of the editor.

- [Runtime JSON Schema v1](v1/schema.json)
- [Build manifest JSON Schema v1](v1/build-manifest.schema.json)
- [Merchant 1 fixture](v1/fixtures/merchant-1.json)
- [Merchant 2 fixture](v1/fixtures/merchant-2.json)
- [Implementation, security boundaries and checks](../../../../commerce-docs/backend/mobile-experience.md)
- [Product roadmap](../../../../commerce-docs/mobile/plans/native-preview-and-release.md)

The gateway validates JSON Schema before contextual ownership, entitlements, translations, contrast and compatibility. OpenAPI models are projected by the owning [generator](../../api-gateway/openapi/mobile_contract.py); edit the canonical schemas before regenerating API models. Remote reference resolution is disabled in the Rust validator.

Drafts use `configVersion: 0`; publication assigns the immutable version. Strings are plain text, component/action types are closed allowlists, asset values are owned identifiers, and native renderers must never interpret configuration as executable code. Swift/Kotlin models and bundled schemas are generated with `python3 commerce-mobile-apps/tools/generate_contract.py`.

Runtime 1.1 adds optional `navigation.icons` overrides shared by Studio preview, SwiftUI and Compose. Existing configurations retain their default icons. Icon overrides require both minimum runtimes to be `1.1.0`; deploy the new gateway/Studio and distribute updated native apps before publishing them. See the [native parity and rollout notes](../../../../commerce-docs/mobile/history/native-milestones-2026-10-11.md#admin-design-parity--runtime-11).
