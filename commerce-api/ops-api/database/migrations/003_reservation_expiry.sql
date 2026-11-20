ALTER TABLE tenants DROP CONSTRAINT tenants_store_slug_key;
ALTER TABLE tenants DROP CONSTRAINT tenants_lifecycle_status_check;
ALTER TABLE tenants
  ADD CONSTRAINT tenants_lifecycle_status_check
  CHECK (lifecycle_status IN (
    'SLUG_RESERVED', 'QUEUED', 'ALLOCATING', 'DEPLOYING', 'VALIDATING',
    'ACTIVE', 'FAILED_REQUIRES_REVIEW', 'SUSPENDED', 'RESERVATION_EXPIRED'
  ));
CREATE UNIQUE INDEX tenants_live_store_slug
  ON tenants(store_slug)
  WHERE lifecycle_status <> 'RESERVATION_EXPIRED';

ALTER TABLE tenant_domains DROP CONSTRAINT tenant_domains_hostname_key;
CREATE UNIQUE INDEX tenant_domains_live_hostname
  ON tenant_domains(hostname)
  WHERE route_status <> 'EXPIRED';
