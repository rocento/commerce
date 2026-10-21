CREATE SCHEMA support;
CREATE TABLE support.tickets (
 id uuid PRIMARY KEY, number bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 tenant_id uuid NOT NULL, owner_key text NOT NULL,
 customer_id uuid REFERENCES customers.customers(id),
 request_id uuid NOT NULL, request_hash text NOT NULL,
 subject text NOT NULL CHECK(length(subject) BETWEEN 1 AND 160),
 category text NOT NULL CHECK(category IN ('order_issue','product_question','complaint','payment_dispute','other')),
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','resolved','closed')),
 priority text NOT NULL CHECK(priority IN ('normal','high')),
 order_id uuid REFERENCES orders.orders(id),
 contact_name text, contact text,
 created_at timestamptz NOT NULL DEFAULT now(), resolved_at timestamptz,
 UNIQUE(tenant_id,owner_key,request_id)
);
CREATE INDEX tickets_customer ON support.tickets(tenant_id,customer_id,created_at DESC);
CREATE TABLE support.messages (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, ticket_id uuid NOT NULL REFERENCES support.tickets(id),
 request_id uuid NOT NULL, actor_key text NOT NULL, request_hash text NOT NULL,
 sender text NOT NULL CHECK(sender IN ('customer','admin','assistant_summary')),
 body text NOT NULL CHECK(length(body) BETWEEN 1 AND 2000), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,ticket_id,actor_key,request_id)
);
CREATE TABLE support.audit (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, ticket_id uuid NOT NULL REFERENCES support.tickets(id),
 actor_key text NOT NULL, action text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
