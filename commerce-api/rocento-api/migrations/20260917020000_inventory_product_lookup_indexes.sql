-- Stock updates and search indexing look up projections by product, whereas
-- their primary keys begin with source_id/stock_id. Avoid full-table scans
-- for every product as the catalog grows. IF NOT EXISTS also supports the
-- same additive indexes being applied during an isolated Quality rollout.
CREATE INDEX IF NOT EXISTS source_items_product_lookup ON inventory.source_items(product_id);
CREATE INDEX IF NOT EXISTS source_availability_product_lookup ON inventory.source_availability(product_id);
CREATE INDEX IF NOT EXISTS stock_availability_product_lookup ON inventory.stock_availability(product_id);
