-- Global pools expose availability independently of delivery coverage.
-- Existing pools remain local; checkout continues to use delivery-area assignments.
ALTER TABLE inventory.stocks ADD COLUMN is_global boolean NOT NULL DEFAULT false;
CREATE INDEX global_stock_pools ON inventory.stocks(id) WHERE is_global;
