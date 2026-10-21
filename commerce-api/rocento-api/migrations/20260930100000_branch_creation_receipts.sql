-- Retain the original request so retries never recreate or overwrite a branch.
CREATE TABLE fulfillment.branch_creation_receipts (
    store_id uuid PRIMARY KEY REFERENCES fulfillment.stores(id),
    request jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
