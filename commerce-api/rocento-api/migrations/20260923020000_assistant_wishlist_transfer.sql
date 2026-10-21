-- Durable exact-request receipt for the atomic wishlist-to-cart command.
-- Rows share the single cart action claim so a request cannot also invoke a
-- separate cart mutation, and exact retries return the saved result.
CREATE TABLE cart_checkout.assistant_wishlist_transfers (
    customer_id uuid NOT NULL,
    request_id uuid NOT NULL,
    product_ids uuid[] NOT NULL,
    result jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (customer_id, request_id),
    FOREIGN KEY (customer_id, request_id)
        REFERENCES cart_checkout.assistant_actions(customer_id, request_id)
        ON DELETE CASCADE,
    CHECK (cardinality(product_ids) BETWEEN 1 AND 200),
    CHECK (jsonb_typeof(result) = 'object')
);
