CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX reservation_product_expiry ON inventory.reservations(product_id,expires_at) INCLUDE(quantity);
CREATE TABLE admin_iam.export_jobs (
 id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES admin_iam.admin_users(id),
 grid text NOT NULL, request jsonb NOT NULL, columns jsonb NOT NULL, format text NOT NULL CHECK(format IN ('csv','xlsx')),
 tenant_id uuid, status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed','cancelled')),
 rows_processed bigint NOT NULL DEFAULT 0, bytes_written bigint NOT NULL DEFAULT 0,
 error text, created_at timestamptz NOT NULL DEFAULT now(), heartbeat_at timestamptz,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '24 hours'
);
CREATE INDEX export_queue ON admin_iam.export_jobs(created_at) WHERE status='queued';
CREATE INDEX export_owner ON admin_iam.export_jobs(owner_id,created_at DESC);
CREATE TABLE admin_iam.export_chunks (
 job_id uuid NOT NULL REFERENCES admin_iam.export_jobs(id) ON DELETE CASCADE,
 sequence integer NOT NULL, data bytea NOT NULL CHECK(octet_length(data)<=1048576), PRIMARY KEY(job_id,sequence)
);
CREATE INDEX grid_catalog_search ON catalog.products USING gin ((name || ' ' || sku) gin_trgm_ops);
CREATE INDEX grid_catalog_category_id ON catalog.products(category_id,id);
CREATE INDEX grid_catalog_active ON catalog.products(active,id);
CREATE INDEX grid_categories_search ON catalog.categories USING gin ((name) gin_trgm_ops);
CREATE INDEX grid_attributes_search ON catalog.attributes USING gin ((name) gin_trgm_ops);
CREATE INDEX grid_media_search ON catalog.media USING gin ((alt) gin_trgm_ops);
CREATE INDEX grid_orders_search ON orders.orders USING gin ((status) gin_trgm_ops);
CREATE INDEX grid_orders_status ON orders.orders(status,id);
CREATE INDEX grid_users_search ON admin_iam.admin_users USING gin ((name || ' ' || email) gin_trgm_ops);
CREATE INDEX grid_users_active ON admin_iam.admin_users(active,id);
CREATE INDEX grid_users_role_id ON admin_iam.admin_users(role_id,id);
CREATE INDEX grid_roles_search ON admin_iam.roles USING gin ((name) gin_trgm_ops);
CREATE INDEX grid_audit_search ON admin_iam.audit_log USING gin ((action || ' ' || coalesce(actor_id::text,'') || ' ' || entity_id::text || ' ' || details::text) gin_trgm_ops);
CREATE INDEX grid_content_search ON cms.documents USING gin ((key) gin_trgm_ops);
CREATE INDEX grid_content_kind ON cms.documents(kind,id);
CREATE INDEX grid_reviews_search ON reviews.reviews USING gin ((title) gin_trgm_ops);
CREATE INDEX grid_reviews_status ON reviews.reviews(status,id);
CREATE INDEX grid_promotions_search ON pricing_promotions.rules USING gin ((name) gin_trgm_ops);
CREATE INDEX grid_promotions_active ON pricing_promotions.rules(active,id);
CREATE INDEX grid_tax_search ON tax.rules USING gin ((name) gin_trgm_ops);
CREATE INDEX grid_tax_active ON tax.rules(active,id);
CREATE INDEX grid_support_search ON support.tickets USING gin ((subject) gin_trgm_ops);
CREATE INDEX grid_support_status ON support.tickets(status,id);
CREATE INDEX grid_support_tenant ON support.tickets(tenant_id,id);
CREATE INDEX grid_support_tenant_status ON support.tickets(tenant_id,status,id);
CREATE INDEX grid_catalog_category_active ON catalog.products(category_id,active,id);
CREATE INDEX grid_catalog_sort_sku ON catalog.products(sku,id);
CREATE INDEX grid_catalog_category_id_sku ON catalog.products(category_id,sku,id);
CREATE INDEX grid_catalog_active_sku ON catalog.products(active,sku,id);
CREATE INDEX grid_catalog_sort_name ON catalog.products(name,id);
CREATE INDEX grid_catalog_category_id_name ON catalog.products(category_id,name,id);
CREATE INDEX grid_catalog_active_name ON catalog.products(active,name,id);
CREATE INDEX grid_categories_sort_name ON catalog.categories(name,id);
CREATE INDEX grid_attributes_sort_name ON catalog.attributes(name,id);
CREATE INDEX grid_media_sort_created_at ON catalog.media(created_at,id);
CREATE INDEX grid_orders_sort_number ON orders.orders(number,id);
CREATE INDEX grid_orders_status_number ON orders.orders(status,number,id);
CREATE INDEX grid_orders_sort_created_at ON orders.orders(created_at,id);
CREATE INDEX grid_orders_status_created_at ON orders.orders(status,created_at,id);
CREATE INDEX grid_users_sort_name ON admin_iam.admin_users(name,id);
CREATE INDEX grid_users_role_id_name ON admin_iam.admin_users(role_id,name,id);
CREATE INDEX grid_users_active_name ON admin_iam.admin_users(active,name,id);
CREATE INDEX grid_roles_sort_name ON admin_iam.roles(name,id);
CREATE INDEX grid_audit_sort_created_at ON admin_iam.audit_log(created_at,id);
CREATE INDEX grid_content_sort_key ON cms.documents(key,id);
CREATE INDEX grid_content_kind_key ON cms.documents(kind,key,id);
CREATE INDEX grid_reviews_sort_created_at ON reviews.reviews(created_at,id);
CREATE INDEX grid_reviews_status_created_at ON reviews.reviews(status,created_at,id);
CREATE INDEX grid_promotions_sort_name ON pricing_promotions.rules(name,id);
CREATE INDEX grid_promotions_active_name ON pricing_promotions.rules(active,name,id);
CREATE INDEX grid_promotions_sort_priority ON pricing_promotions.rules(priority,id);
CREATE INDEX grid_promotions_active_priority ON pricing_promotions.rules(active,priority,id);
CREATE INDEX grid_tax_sort_name ON tax.rules(name,id);
CREATE INDEX grid_tax_active_name ON tax.rules(active,name,id);
CREATE INDEX grid_tax_sort_priority ON tax.rules(priority,id);
CREATE INDEX grid_tax_active_priority ON tax.rules(active,priority,id);
CREATE INDEX grid_support_sort_number ON support.tickets(number,id);
CREATE INDEX grid_support_tenant_id_number ON support.tickets(tenant_id,number,id);
CREATE INDEX grid_support_tenant_id_status_number ON support.tickets(tenant_id,status,number,id);
CREATE INDEX grid_support_sort_created_at ON support.tickets(created_at,id);
CREATE INDEX grid_support_tenant_id_created_at ON support.tickets(tenant_id,created_at,id);
CREATE INDEX grid_support_tenant_id_status_created_at ON support.tickets(tenant_id,status,created_at,id);
