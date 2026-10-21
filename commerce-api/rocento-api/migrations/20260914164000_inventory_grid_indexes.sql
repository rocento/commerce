CREATE INDEX grid_sources_name ON inventory.inventory_sources(name,id);
CREATE INDEX grid_sources_search ON inventory.inventory_sources USING gin(name gin_trgm_ops);
CREATE INDEX grid_stocks_name ON inventory.stocks(name,id);
CREATE INDEX grid_stocks_search ON inventory.stocks USING gin(name gin_trgm_ops);
CREATE INDEX grid_areas_name ON inventory.delivery_areas(name,id);
CREATE INDEX grid_areas_search ON inventory.delivery_areas USING gin(name gin_trgm_ops);
CREATE INDEX grid_allocations_source_product ON inventory.reservation_allocations(source_id,product_id,cart_id) INCLUDE(quantity);
