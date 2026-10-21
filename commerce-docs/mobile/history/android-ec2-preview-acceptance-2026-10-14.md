# Android EC2 preview pilot — 2026-10-14

Historical checkpoint. Later records may supersede these deployment statements; see the [mobile status](../../frontend/README.md) and [history index](README.md).

## Host and deployment

- Instance: `i-0af639278db7286a9`, `m7i.large`, Frankfurt (`eu-central-1a`).
- Public Elastic IP: `63.178.132.120`; private IP: `172.31.20.210`.
- Ubuntu 26.04 x86_64, 40 GB gp3 volume, nested virtualization enabled.
- ED25519 host identity independently verified against the authenticated AWS Console system log before SSH: `SHA256:rx9gZ/c0HMGxEN5co9B3aAmex8wloXASg4FmOKuh/jM`.
- Dedicated `rocento-preview` system account, KVM group access, private `/opt/rocento-preview` directory.
- Official Android SDK, Android 36 Google APIs x86_64 system image, Build Tools 35.0.1, JRE 21.
- Emulator acceleration check: KVM version 12 installed and usable.
- Systemd unit: `deploy/native-preview/rocento-android-preview.service`.
- Worker bearer secret in root-only `/etc/rocento-android-preview.env`; no secret included in this report.
- Worker `19096`, ADB `5038`, emulator `5580/5581` verified bound to loopback only.

## Artifact

Rocento Studio debug APK built with `-PappBuilder=true -PpreviewOrigin=https://grocery.rocento.com/api`.

- Package: `com.rocento.grocery`, version code 4.
- APK SHA-256: `fa1001ffa9c4a600f2e17372a27c465810299ad72df7669a2f61b9a6e44afd9a`.
- Signing certificate SHA-256: `e741ac7499af7d37de94a2b29ad98418b41560d2144e348ac0a38e08055bef7f`.
- Local artifact gate and remote pre-install signature/destination gate passed.
- No local acceptance CA or local API origin included.

## Initial infrastructure-only acceptance (superseded by live acceptance below)

This is an EC2 worker infrastructure smoke test, using a deliberately nonfunctional draft capability. Native storefront rendering and input can be tested independently; successful live draft fetch/ACK is not claimed.

Eleven worker tests passed on EC2. Initial cold boot to first native frame took 80.08 seconds. Native storefront imagery rendered. Unauthorized calls returned 401; replayed input returned 409; reconnect and stop succeeded; disposable device state was removed.

The first search check displayed `lk` instead of `milk` while the field was opening; the repeat with a four-second focus settling interval verified the full `milk` text in the native UI tree. Second cold boot: 82.07 seconds; measured screenshot stream: 1.98 fps. Do not equate accepted input HTTP responses with verified native text.

Live apps.rocento.com integration has not been deployed. The existing demo source checkout lacks the preview worker module and preview migrations. It is also serving newer release layers than its source checkout, so replacing the gateway from that stale checkout would risk unrelated regressions. A scoped release based on the actual deployed gateway source is required before live integration, along with private worker transport and valid draft/ACK acceptance.

Evidence: `output/android-ec2-preview-20261014/evidence/`.

## Initial worker test result

Native UI tree verified `milk` after focus settled. Tap, text and swipe requests returned 204; unauthorized request 401; replayed sequence 409; reconnect 200; stop 204. Device state cleanup passed. Second cold boot was 82.07 seconds and the screenshot stream measured 1.98 fps. This qualifies only as a basic single-session preview pilot, not smooth video.

A graceful EC2 stop was requested through AWS Console after evidence retrieval to avoid idle compute charges. EBS and the allocated Elastic IP remain billable while stopped. Website start/stop controls and automatic idle shutdown are not configured.

AWS Console subsequently confirmed instance state **Stopped**.


## Live App Studio acceptance

Deployed `apps-android-ec2-20261014` at https://apps.rocento.com. The commerce gateway uses the coordinated migration-compatible image `sha256:904d62ab057446d893b1629aaede4bf3a455690292689756a49d96e9290cc30b`; isolated preview gateway `sha256:83183535ec7d01c3152becf639406709b04876b4cd16628c33e2cbdbf059ddb2` handles only native sessions and lifecycle routes. Other containers were unchanged and all four admin health checks passed. Backups and rollback metadata are under `/var/backups/rocento/apps-android-ec2-20261014` on the demo host.

The approved `RocentoAndroidPreviewControl` role is attached to demo instance `i-02c1e79a38687db82`. It can describe instances in Frankfurt and start/stop only the Android instance. Private SSH forwarding connects the loopback worker; no emulator, ADB or worker port is public.

Live authenticated browser acceptance:
- Android native preview opened and streamed at approximately 2 fps.
- Initial saved draft r59 was acknowledged by the native app.
- Primary color changed temporarily from `#063c22` to `#164f9e`: draft r60 saved and native acknowledgement showed up to date. Screenshot `output/android-ec2-preview-20261014/evidence/live-draft-r60.png` shows blue native icons and links.
- Restored exact original primary color `#063c22`: draft r61 saved and acknowledged. Published release stayed v6; no draft was published.
- Database independently confirmed delivered_revision=61, applied_revision=61, applied_at=2026-10-13T22:18:54.46507Z. Session revoked at 22:18:55.961209Z.
- Shutdown button disabled while one preview was active; enabled after disposable-device cleanup.
- Five controller tests, thirteen worker tests, and the owner/fixed-merchant authorization integration test passed. TypeScript and Rust checks and production builds passed.

Website controls are owner-only. Use Native Preview → Android → Start Android server → Open Android Preview. Finish with Stop native preview, wait for cleanup, then Stop Android server. Automatic idle EC2 shutdown is not implemented; session expiry alone does not stop EC2. Disk and allocated IP charges continue while stopped. This remains a single-session, low-frame-rate preview pilot.

Lifecycle acceptance completed through the live website: Stop → Stopped; Start → Ready with automatic private tunnel reconnection; final Stop → Stopped. Anonymous POST to the live lifecycle endpoint returned 403. Final Android instance state was visibly confirmed **Stopped** in App Studio.
