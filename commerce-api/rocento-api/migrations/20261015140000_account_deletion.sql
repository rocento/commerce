-- Policies are installation-bound, immutable versions. No default retention period.
CREATE TABLE customers.retention_policies (
 id uuid PRIMARY KEY, merchant_id uuid NOT NULL,
 legal_entity text NOT NULL, jurisdictions text[] NOT NULL,
 financial_days integer NOT NULL CHECK(financial_days BETWEEN 0 AND 36525),
 retain_contact boolean NOT NULL, retain_address boolean NOT NULL,
 approved_by uuid NOT NULL REFERENCES admin_iam.admin_users(id),
 approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 active boolean NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX retention_policy_active ON customers.retention_policies(merchant_id) WHERE active;
ALTER TABLE customers.customers ADD COLUMN deletion_requested_at timestamptz;
ALTER TABLE customers.customers ADD COLUMN deleted_at timestamptz;
CREATE TABLE customers.deletion_requests (
 id uuid PRIMARY KEY, merchant_id uuid NOT NULL, customer_id uuid NOT NULL UNIQUE,
 policy_id uuid NOT NULL REFERENCES customers.retention_policies(id),
 receipt_hash text NOT NULL UNIQUE,
 state text NOT NULL CHECK(state IN ('requested','waiting','processing','failed','complete')),
 waiting_reason text, hold_until timestamptz, hold_reason text,
 attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 commerce_erased_at timestamptz, engagement_erased_at timestamptz, assistant_erased_at timestamptz, analytics_erased_at timestamptz,
 requested_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz,
 cart_ids uuid[] NOT NULL DEFAULT '{}', order_ids uuid[] NOT NULL DEFAULT '{}', session_ids uuid[] NOT NULL DEFAULT '{}',
 last_error text
);
CREATE INDEX deletion_requests_due ON customers.deletion_requests(next_attempt_at) WHERE state<>'complete';
CREATE TABLE customers.retained_transactions (
 request_id uuid NOT NULL REFERENCES customers.deletion_requests(id), order_id uuid NOT NULL,
 record jsonb NOT NULL, expires_at timestamptz NOT NULL,
 PRIMARY KEY(request_id,order_id)
);
CREATE INDEX retained_transactions_expiry ON customers.retained_transactions(expires_at);
-- Every new session/customer-owned write serializes with deletion admission.
-- A tombstone contains no password or real contact and prevents delayed writers
-- from recreating customer data after erasure.
CREATE FUNCTION customers.guard_deleted_owner() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner uuid; unavailable boolean;
BEGIN
 IF current_setting('commerce.erasure',true)='on' THEN RETURN NEW; END IF;
 owner := (to_jsonb(NEW)->>TG_ARGV[0])::uuid;
 IF owner IS NULL THEN RETURN NEW; END IF;
 SELECT deletion_requested_at IS NOT NULL INTO unavailable FROM customers.customers WHERE id=owner FOR SHARE;
 IF COALESCE(unavailable,false) THEN RAISE EXCEPTION 'Account unavailable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE target text; BEGIN
 FOREACH target IN ARRAY ARRAY['customers.sessions','customers.challenges','customers.customer_locations','customers.memory_subjects','customers.journey_events','reviews.reviews','reviews.wishlist','support.tickets','cart_checkout.carts','cart_checkout.quotes','cart_checkout.assistant_actions','fulfillment.plans','fulfillment.capacity_reservations','cart_checkout.delegation_grants','platform.notification_jobs','platform.order_push_jobs','platform.customer_push_devices','platform.marketing_notification_records','platform.marketing_notification_requests','platform.storefront_notification_recipients','platform.storefront_notification_publications'] LOOP
  EXECUTE format('CREATE TRIGGER deleted_owner BEFORE INSERT ON %s FOR EACH ROW EXECUTE FUNCTION customers.guard_deleted_owner(''customer_id'')', target);
 END LOOP;
END $$;
CREATE TRIGGER deleted_order_owner BEFORE INSERT ON orders.orders FOR EACH ROW EXECUTE FUNCTION customers.guard_deleted_owner('customer_id');

CREATE FUNCTION customers.immutable_retention_policy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (to_jsonb(NEW)-'active') IS DISTINCT FROM (to_jsonb(OLD)-'active') THEN
  RAISE EXCEPTION 'Create a new retention policy version';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_retention_policy BEFORE UPDATE ON customers.retention_policies
 FOR EACH ROW EXECUTE FUNCTION customers.immutable_retention_policy();
CREATE FUNCTION customers.guard_deleted_profile() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.deleted_at IS NOT NULL AND current_setting('commerce.erasure',true) IS DISTINCT FROM 'on' THEN
  RAISE EXCEPTION 'Account unavailable' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER deleted_profile BEFORE UPDATE ON customers.customers FOR EACH ROW EXECUTE FUNCTION customers.guard_deleted_profile();

CREATE TABLE customers.erased_carts(id uuid PRIMARY KEY);
