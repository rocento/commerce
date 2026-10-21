CREATE TABLE inventory.replenishment_policies (
 product_id uuid PRIMARY KEY REFERENCES catalog.products(id) ON DELETE CASCADE,
 supplier text NOT NULL DEFAULT '',
 planning_group text NOT NULL DEFAULT '',
 lead_time_days integer NOT NULL DEFAULT 7 CHECK (lead_time_days BETWEEN 0 AND 3650),
 target_cover_days integer NOT NULL DEFAULT 30 CHECK (target_cover_days BETWEEN 1 AND 3650),
 safety_stock_days integer NOT NULL DEFAULT 3 CHECK (safety_stock_days BETWEEN 0 AND 3650),
 minimum_order_qty integer NOT NULL DEFAULT 1 CHECK (minimum_order_qty BETWEEN 1 AND 1000000),
 order_multiple integer NOT NULL DEFAULT 1 CHECK (order_multiple BETWEEN 1 AND 1000000),
 enabled boolean NOT NULL DEFAULT true,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX replenishment_policy_supplier ON inventory.replenishment_policies(supplier, planning_group);
CREATE INDEX replenishment_sales_product_date ON orders.order_items(product_id, order_id);
CREATE INDEX replenishment_order_date_status ON orders.orders(created_at, status, id);

CREATE TABLE inventory.replenishment_refreshes (
 id boolean PRIMARY KEY DEFAULT true CHECK (id),
 refreshed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 refreshed_by uuid
);
INSERT INTO inventory.replenishment_refreshes(id) VALUES(true);
