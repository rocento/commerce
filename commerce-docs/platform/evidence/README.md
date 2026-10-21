# Historical evidence catalog

This catalog makes historical attachment references portable. It records paths and file hashes for attachments referenced by maintained guides; it does not copy their contents or establish current production acceptance.

All 67 entries are **unavailable** after `commerce-output` was emptied at the user's request on 2026-10-14. No durable archive location was registered. The [machine-readable manifest](local-evidence.json) retains the former relative paths and hashes as provenance, not as a claim that the payloads can be retrieved. Do not substitute a newer run and present it as the recorded evidence.

## Verification and retention

Default documentation checks validate metadata without requiring local payloads. For future entries marked `local-only`, run from the repository root:

```sh
python3 commerce-scripts/check-documentation.py --check-local-evidence
```

This checks each locally available file size and full SHA-256 hash. Entries marked `unavailable` are skipped because their payloads were removed. Directory entries only record a location; they do not certify every descendant.

When a run owner archives evidence, record the durable location, archive hash and verified restoration in the run manifest before updating availability here. Keep credentials and customer data in approved protected storage; the repository catalog holds metadata only. See [the output lifecycle and manifest template](../reference/workspace-cleanup.md#retained-evidence).

## Catalog

The short hashes below identify the former files; the complete hashes and source-document references are in the JSON manifest. This catalog covers explicitly linked attachments, not every path mentioned in commands or prose.

### android-native-preview-20261013

| Former path | Kind | Bytes | SHA-256 prefix |
| --- | --- | ---: | --- |
| <a id="evidence-d29a5e2adb7ffa45"></a>`output/android-native-preview-20261013/android-draft-updated.png` | file | 39536 | 5b192a38d0d0b00b |
| <a id="evidence-02503fed3fa1dc41"></a>`output/android-native-preview-20261013/android-keyboard.png` | file | 66498 | 05435782e9da6b98 |
| <a id="evidence-e1cb30739587d15a"></a>`output/android-native-preview-20261013/builder-android.png` | file | 217215 | 71d53509bf3c119a |
| <a id="evidence-1de79e3ce5369ea1"></a>`output/android-native-preview-20261013/result.json` | file | 214 | e03c54f3a04d6fd0 |

### db-driven-language-20261010

| Former path | Kind | Bytes | SHA-256 prefix |
| --- | --- | ---: | --- |
| <a id="evidence-e85d651906e1a9d0"></a>`output/db-driven-language-20261010/activation/verification.json` | file | 8097 | 9204977a567a6410 |

### enterprise-knowledge-expansion-batch1-20261010

| Former path | Kind | Bytes | SHA-256 prefix |
| --- | --- | ---: | --- |
| <a id="evidence-eccc95d41073da65"></a>`output/enterprise-knowledge-expansion-batch1-20261010/acceptance-lock.json` | file | 856 | 9237108f9e5d59ee |
| <a id="evidence-0fa32f5c766ad6c4"></a>`output/enterprise-knowledge-expansion-batch1-20261010/production-inventory.txt` | file | 181306 | a59eafba0e38d3aa |
| <a id="evidence-25d8bf88e0ec90ce"></a>`output/enterprise-knowledge-expansion-batch1-20261010/verification.json` | file | 6481 | 6d48baee785433f1 |

### enterprise-knowledge-phase0-20261010

| Former path | Kind | Bytes | SHA-256 prefix |
| --- | --- | ---: | --- |
| <a id="evidence-8c8273bc678d7156"></a>`output/enterprise-knowledge-phase0-20261010` | directory | — | Directory only |
| <a id="evidence-0dd13b7ee15f02d0"></a>`output/enterprise-knowledge-phase0-20261010/baseline-summary.json` | file | 12580 | bd1cee201d27fd16 |
| <a id="evidence-84287ae03b7dd212"></a>`output/enterprise-knowledge-phase0-20261010/benchmark-approved.json` | file | 45964 | c9c87e601639f3ec |
| <a id="evidence-b84bd43678fcd273"></a>`output/enterprise-knowledge-phase0-20261010/benchmark-review.md` | file | 14816 | ff1d016c60a0a377 |
| <a id="evidence-7dcf291c556acbd7"></a>`output/enterprise-knowledge-phase0-20261010/case-classification.json` | file | 6121205 | d1ba7e8a845d1055 |
| <a id="evidence-932ad00f7bd14249"></a>`output/enterprise-knowledge-phase0-20261010/local-performance.json` | file | 2534 | 49bce3e22097fa09 |
| <a id="evidence-ed09ca8174becdf5"></a>`output/enterprise-knowledge-phase0-20261010/offline-language-replay.json` | file | 6716900 | d13ed76585d4b5f9 |
| <a id="evidence-758da7b15f99165c"></a>`output/enterprise-knowledge-phase0-20261010/production-inventory.json` | file | 235208 | 8380dacc11c29f8c |
| <a id="evidence-77e7e4eb0ac10cd9"></a>`output/enterprise-knowledge-phase0-20261010/production-runtime.jsonl` | file | 5396 | 76ff4b5868356ee4 |
| <a id="evidence-f08f761f9fad9527"></a>`output/enterprise-knowledge-phase0-20261010/release-inventory.json` | file | 8734 | cd966f7eabc2163f |
| <a id="evidence-18c0f98285bcfac0"></a>`output/enterprise-knowledge-phase0-20261010/snapshot-manifest.json` | file | 18607 | 8fd1bf138b0fe594 |

### enterprise-knowledge-production-verification-20261010

| Former path | Kind | Bytes | SHA-256 prefix |
| --- | --- | ---: | --- |
| <a id="evidence-bf1383c1d0f6e39a"></a>`output/enterprise-knowledge-production-verification-20261010/exact-name-python-baseline.json` | file | 127023 | d6e7b60852b6fa94 |
| <a id="evidence-29fde7b2632842fc"></a>`output/enterprise-knowledge-production-verification-20261010/verification.json` | file | 5064 | f350eca600e101d3 |

### enterprise-knowledge-release-prep-20261010

| Former path | Kind | Bytes | SHA-256 prefix |
| --- | --- | ---: | --- |
| <a id="evidence-03508acd2a9b22a4"></a>`output/enterprise-knowledge-release-prep-20261010` | directory | — | Directory only |
| <a id="evidence-f380b288bacf9b08"></a>`output/enterprise-knowledge-release-prep-20261010/archived-diagnostics/all-failures.jsonl` | file | 2948603 | e767f812c148de96 |
| <a id="evidence-9d73b5c62b0cb05e"></a>`output/enterprise-knowledge-release-prep-20261010/archived-diagnostics/summary.json` | file | 26666 | 8a3a27c2230e5ec1 |
| <a id="evidence-49b08dd3d467f7ed"></a>`output/enterprise-knowledge-release-prep-20261010/initial-archived-corpus.json` | file | 19635 | d6dadc1e0fa7bff7 |
| <a id="evidence-a0adec6795134195"></a>`output/enterprise-knowledge-release-prep-20261010/live-catalog-verified/demo-validation.json` | file | 384393 | da04ccba5baa117e |
| <a id="evidence-af946b86d7aa9eb3"></a>`output/enterprise-knowledge-release-prep-20261010/production-images.txt` | file | 1271 | 31130dca5d0f1777 |
| <a id="evidence-41fb3ecd4d683dfa"></a>`output/enterprise-knowledge-release-prep-20261010/python-deployment-validation.json` | file | 2721 | ffe3e4e200a1ede7 |
| <a id="evidence-97b85926d7c9f37b"></a>`output/enterprise-knowledge-release-prep-20261010/release-rehearsal.json` | file | 9594 | 6277750f7342bdf6 |
| <a id="evidence-82b9ac5005887f73"></a>`output/enterprise-knowledge-release-prep-20261010/rollback-backup.json` | file | 1255 | de6e5b2a00b61b5e |
| <a id="evidence-62184cb9447d6962"></a>`output/enterprise-knowledge-release-prep-20261010/verification.json` | file | 2537 | c906ec49cf20ef30 |

### enterprise-knowledge-release-repair-20261010

| Former path | Kind | Bytes | SHA-256 prefix |
| --- | --- | ---: | --- |
| <a id="evidence-2575f3c866670f46"></a>`output/enterprise-knowledge-release-repair-20261010/benchmark-v4` | directory | — | Directory only |
| <a id="evidence-c64cfced20a27c0b"></a>`output/enterprise-knowledge-release-repair-20261010/final` | directory | — | Directory only |
| <a id="evidence-231c55d4753a7f08"></a>`output/enterprise-knowledge-release-repair-20261010/final/assistant-migration-decision.json` | file | 2261 | b15e78aaa42bc856 |
| <a id="evidence-d07b60b01e2dc621"></a>`output/enterprise-knowledge-release-repair-20261010/final/performance-comparison.md` | file | 3073 | fd79ca316d0d439b |
| <a id="evidence-ff0e25e4f44a76b5"></a>`output/enterprise-knowledge-release-repair-20261010/final/python-production-overlay-handoff.json` | file | 11972 | 3b4a7e66a0b3f735 |
| <a id="evidence-8c5922b91d7b7efd"></a>`output/enterprise-knowledge-release-repair-20261010/final/verification.json` | file | 9231 | fdaad319acaf3dcf |

### ios-fps-20261014

| Former path | Kind | Bytes | SHA-256 prefix |
| --- | --- | ---: | --- |
| <a id="evidence-4ab2ad30c7ecf6c2"></a>`output/ios-fps-20261014/android-paced-kotlin-60.png` | file | 186913 | 3606d2a428d712f4 |
| <a id="evidence-97b5c7390ed80ea6"></a>`output/ios-fps-20261014/android-paced-react-native-60.png` | file | 195760 | cfc464f68e1bf1e9 |
| <a id="evidence-841bf04a92b71a95"></a>`output/ios-fps-20261014/ios-60.png` | file | 206173 | 29f6176be5a74c4a |
| <a id="evidence-5b410c88c6b26727"></a>`output/ios-fps-20261014/summary.json` | file | 12900 | a5b97e1b60379534 |

### native-interactive-preview-20261013

| Former path | Kind | Bytes | SHA-256 prefix |
| --- | --- | ---: | --- |
| <a id="evidence-5a359649d8b77ab3"></a>`output/native-interactive-preview-20261013/builder-video.png` | file | 760688 | ec8f7d6c97ba9c77 |
| <a id="evidence-b35dfa8ef5ab6a8a"></a>`output/native-interactive-preview-20261013/native-home.png` | file | 208644 | 29efc94d61bc63a2 |
| <a id="evidence-01d90e95d4f4eb15"></a>`output/native-interactive-preview-20261013/native-interaction.webm` | file | 2302634 | 8ca1be79fa4c4725 |
| <a id="evidence-bd837157806a2ac7"></a>`output/native-interactive-preview-20261013/native-keyboard.png` | file | 200585 | fda371908b74f12a |
| <a id="evidence-a107458a6dc6e310"></a>`output/native-interactive-preview-20261013/native-scrolled.png` | file | 224008 | e3eb077e2d423bab |
| <a id="evidence-3a1684ea65c9b289"></a>`output/native-interactive-preview-20261013/result.json` | file | 226 | f16cf00ea23521d6 |
| <a id="evidence-27176a5a23ab963f"></a>`output/native-interactive-preview-20261013/theme-sync/result.json` | file | 543 | 952a10f3c9ce552d |

### native-preview-20261013

| Former path | Kind | Bytes | SHA-256 prefix |
| --- | --- | ---: | --- |
| <a id="evidence-b6a7f2d76a8fae3b"></a>`output/native-preview-20261013/builder-after.png` | file | 278770 | 255020659cc969a7 |
| <a id="evidence-4ac2bd3ac933c8b1"></a>`output/native-preview-20261013/native-offline.png` | file | 138879 | a54be66e505c84d9 |
| <a id="evidence-deac4baa08270062"></a>`output/native-preview-20261013/native-recovered.png` | file | 137055 | 1b5bcb378fec3da1 |
| <a id="evidence-62ba9d1276cff90a"></a>`output/native-preview-20261013/result.json` | file | 457 | cb5957dd351eb0a6 |
| <a id="evidence-1c8c7d053b350844"></a>`output/native-preview-20261013/studio-signing-check.json` | file | 679 | 6f0fc9a3dc735eac |

### native-worker-stream-20261013

| Former path | Kind | Bytes | SHA-256 prefix |
| --- | --- | ---: | --- |
| <a id="evidence-306a03360f92b7c0"></a>`output/native-worker-stream-20261013/builder-stream.png` | file | 278216 | cd1126bab2f26d59 |
| <a id="evidence-57ae6c78f96494a7"></a>`output/native-worker-stream-20261013/native-after.png` | file | 137126 | ae58bdf082df0a94 |
| <a id="evidence-36dd421234aea601"></a>`output/native-worker-stream-20261013/native-before.png` | file | 3042779 | 30a14944b90ac530 |
| <a id="evidence-b75cf5435dced7b4"></a>`output/native-worker-stream-20261013/result.json` | file | 535 | e895fb4dc7eb67a6 |

### react-native-builder-preview-20261013

| Former path | Kind | Bytes | SHA-256 prefix |
| --- | --- | ---: | --- |
| <a id="evidence-54c76a0fa72984c5"></a>`output/react-native-builder-preview-20261013/acceptance.json` | file | 244 | bebeaaa72cb92924 |
| <a id="evidence-9fd262919c8405d3"></a>`output/react-native-builder-preview-20261013/android-edited.jpg` | file | 36093 | 083cf406686aa2d4 |
| <a id="evidence-c801451125cb935f"></a>`output/react-native-builder-preview-20261013/android-input.jpg` | file | 50825 | 78c2d3115a7e86e4 |
| <a id="evidence-7c59c469d8e72e10"></a>`output/react-native-builder-preview-20261013/ios-edited.jpg` | file | 90238 | c2784ea3b79d2579 |
| <a id="evidence-aa17f5612219a120"></a>`output/react-native-builder-preview-20261013/ios-input.jpg` | file | 81148 | 71f33555a592e5a1 |

### react-native-builder-sections-20261014

| Former path | Kind | Bytes | SHA-256 prefix |
| --- | --- | ---: | --- |
| <a id="evidence-fa18b5655013722f"></a>`output/react-native-builder-sections-20261014/acceptance.json` | file | 843 | 54d7ae32d42105b3 |
| <a id="evidence-65d8208e3a2ba335"></a>`output/react-native-builder-sections-20261014/android-sections-scroll-4.jpg` | file | 50457 | f38752dae46baffd |
| <a id="evidence-557d2f47913976e5"></a>`output/react-native-builder-sections-20261014/android-sections-top.jpg` | file | 62272 | 89389216f4b32bb0 |
| <a id="evidence-5c161d2ac75d5916"></a>`output/react-native-builder-sections-20261014/ios-sections-scroll-3.jpg` | file | 81310 | d7f02a9d8187c4d6 |
| <a id="evidence-0d682718b454f338"></a>`output/react-native-builder-sections-20261014/ios-sections-top.jpg` | file | 102732 | dfeed43cb11c6dba |
