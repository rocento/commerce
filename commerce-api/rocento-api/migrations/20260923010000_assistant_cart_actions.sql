-- Claim a cart mutation before execution. A lost response must never replay an add.
CREATE TABLE cart_checkout.assistant_actions (
    customer_id uuid NOT NULL REFERENCES customers.customers(id),
    request_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (customer_id, request_id)
);
