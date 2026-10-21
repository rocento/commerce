# Customer email delivery

Production supports authenticated SMTP with certificate validation: port 465 uses
implicit TLS, port 587 requires STARTTLS. No plaintext or insecure TLS mode exists.
Namecheap settings: https://www.namecheap.com/support/knowledgebase/article.aspx/1179/2175/general-private-email-configuration-for-mail-clients-and-mobile-devices/

1. Copy `commerce-ops/deploy/aws-deploy/notifications.env.example` to `commerce-ops/deploy/aws-deploy/notifications.env`.
2. Supply the Private Email mailbox SMTP credential, not the platform admin password.
   Keep this file mode 600. It is gitignored; never paste it into logs or tickets.
3. Run the normal `bash commerce-ops/deploy/aws-deploy/deploy.sh` deployment; demo seeding is a separate command. See the [deployment command reference](README.md).
   The protected file is uploaded separately; both stores enable SMTP and use their
   own HTTPS storefront URL for verification/reset links. Missing/invalid required
   SMTP settings fail gateway startup rather than falling back to token logging.
4. Register an email you control, check actual receipt, complete verification, then
   test password reset, expired/reused links and resend. SMTP acceptance alone does
   not prove inbox delivery. Check spam folders and domain SPF/DKIM/DMARC.

Without this file existing development/console behavior is preserved. Quality
does not receive production mailbox credentials. Local Mailpit remains available
through `commerce-ops/compose/compose.notifications.yaml`. Once installed remotely, credentials persist
across deployments; removing the local file does not disable remote SMTP.

The durable PostgreSQL queue expires obsolete challenges, uses a stable Message-ID,
and attempts delivery at most five times. Permanent SMTP rejections fail immediately.
Retries are at-least-once: an ambiguous connection failure can cause duplicates.
Logs contain job IDs and bounded error codes, never SMTP responses, passwords or
verification tokens. Inspect `platform.notification_jobs` status/attempts/last_error
without selecting payloads. Alert on failed jobs and queue age in operations.

Scope: customer verification, password reset, order confirmation and each shipment
dispatch use the durable email queue in SMTP mode. Commerce messages use bounded
plain text and stable event-based Message-IDs; verification/reset messages retain
storefront-origin link validation and their challenge expiry rules. Repeated
dispatch requests do not enqueue another event. Validate order and split-shipment
receipt with a controlled email account in an isolated local test stack before rollout.

SMS is not supported by SMTP and fails explicitly without printing an OTP.
Automated bounce/complaint ingestion and global mailbox quota enforcement are not
included yet. Respect the Namecheap plan limit shared by both stores and the contact
form; use a transactional provider as traffic grows. Keep quality tests off the
production mailbox. Do not enable for public traffic before the live smoke test.
