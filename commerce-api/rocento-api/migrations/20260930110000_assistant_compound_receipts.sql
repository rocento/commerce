-- Independent cart/wishlist operations, each committed with its own receipt.
-- The shared request claim prevents reuse through the legacy cart endpoints.
CREATE TABLE cart_checkout.assistant_compound_requests (
    tenant_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    request_id uuid NOT NULL,
    revision uuid NOT NULL,
    command jsonb NOT NULL,
    receipts jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, customer_id, request_id),
    UNIQUE (tenant_id, customer_id, revision),
    FOREIGN KEY (customer_id, request_id)
        REFERENCES cart_checkout.assistant_actions(customer_id, request_id)
        ON DELETE CASCADE,
    CHECK (jsonb_typeof(command) = 'object' AND pg_column_size(command) <= 16384),
    CHECK (jsonb_typeof(receipts) = 'object' AND pg_column_size(receipts) <= 8192)
);
