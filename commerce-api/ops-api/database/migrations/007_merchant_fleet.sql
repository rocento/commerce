-- Existing merchants keep their local runtime. Staff must explicitly place new stores.
ALTER TABLE tenants ADD COLUMN hosting_provider text
 CHECK(hosting_provider IN ('aws','gcp','hetzner'));
ALTER TABLE tenants ADD CONSTRAINT tenant_provider_identity UNIQUE(id,hosting_provider);
CREATE TABLE merchant_hosts (
 id uuid PRIMARY KEY,
 provider text NOT NULL CHECK(provider IN ('aws','gcp','hetzner')),
 state text NOT NULL DEFAULT 'REQUESTED'
   CHECK(state IN ('REQUESTED','CREATING','BOOTING','READY','FAILED','DRAINING')),
 profile_digest text NOT NULL CHECK(profile_digest ~ '^[a-f0-9]{64}$'),
 release_digest text NOT NULL CHECK(release_digest ~ '^sha256:[a-f0-9]{64}$'),
 provider_reference text,
 provider_operation text,
 address inet,
 error_code text,
 boot_deadline_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(id,provider), UNIQUE(provider,provider_reference)
);
CREATE TABLE merchant_placements (
 tenant_id uuid PRIMARY KEY,
 host_id uuid NOT NULL,
 provider text NOT NULL,
 slot smallint NOT NULL CHECK(slot BETWEEN 1 AND 3),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,provider) REFERENCES tenants(id,hosting_provider),
 FOREIGN KEY(host_id,provider) REFERENCES merchant_hosts(id,provider),
 UNIQUE(host_id,slot)
);
-- Reservations survive suspension, archive and failure. No automatic slot release.
CREATE FUNCTION reserve_merchant_host(job_uuid uuid, lease_uuid uuid, profile text,
 host_limit integer, new_host uuid) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE j provisioning_jobs; t tenants; h merchant_hosts; chosen_slot smallint;
BEGIN
 IF host_limit IS NULL OR profile IS NULL OR new_host IS NULL OR host_limit < 1 OR host_limit > 1000 OR profile !~ '^[a-f0-9]{64}$' THEN
   RAISE EXCEPTION 'INVALID_FLEET_CONFIGURATION';
 END IF;
 SELECT * INTO j FROM provisioning_jobs WHERE id=job_uuid FOR UPDATE;
 SELECT * INTO t FROM tenants WHERE id=j.tenant_id FOR UPDATE;
 IF j.id IS NULL OR lease_uuid IS NULL OR j.status<>'RUNNING' OR j.lease_token IS DISTINCT FROM lease_uuid
 OR j.lease_until<=clock_timestamp() OR t.management_state<>'ENABLED'
 OR t.hosting_provider IS NULL OR j.artifact_digest IS NULL THEN
   RAISE EXCEPTION 'PLACEMENT_NOT_AUTHORIZED';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('merchant-fleet:'||t.hosting_provider,0));
 SELECT host_id,slot INTO h.id,chosen_slot FROM merchant_placements WHERE tenant_id=t.id;
 IF h.id IS NOT NULL THEN
   SELECT * INTO h FROM merchant_hosts WHERE id=h.id;
   RETURN to_jsonb(h)||jsonb_build_object('slot',chosen_slot);
 END IF;
 -- Never relocate a merchant that has started executing on the legacy host.
 IF j.step<>'RELEASE' OR EXISTS(SELECT 1 FROM provisioning_steps WHERE job_id=j.id) THEN
   RAISE EXCEPTION 'EXISTING_RUNTIME_REQUIRES_MIGRATION';
 END IF;
 SELECT * INTO h FROM merchant_hosts mh WHERE provider=t.hosting_provider
   AND state IN ('REQUESTED','CREATING','BOOTING','READY')
   AND profile_digest=profile AND release_digest=j.artifact_digest
   AND (SELECT count(*) FROM merchant_placements WHERE host_id=mh.id)<3
   ORDER BY (state='READY') DESC,created_at,id LIMIT 1 FOR UPDATE;
 IF h.id IS NULL THEN
   IF (SELECT count(*) FROM merchant_hosts WHERE provider=t.hosting_provider)>=host_limit THEN
     RETURN NULL;
   END IF;
   INSERT INTO merchant_hosts(id,provider,profile_digest,release_digest)
     VALUES(new_host,t.hosting_provider,profile,j.artifact_digest) RETURNING * INTO h;
 END IF;
 SELECT s INTO chosen_slot FROM generate_series(1,3) s WHERE NOT EXISTS
   (SELECT 1 FROM merchant_placements WHERE host_id=h.id AND slot=s) ORDER BY s LIMIT 1;
 INSERT INTO merchant_placements(tenant_id,host_id,provider,slot)
   VALUES(t.id,h.id,t.hosting_provider,chosen_slot);
 INSERT INTO audit_events(actor_id,action,target_id)
   VALUES('fleet-controller','store.host.reserved',t.id);
 RETURN to_jsonb(h)||jsonb_build_object('slot',chosen_slot);
END $$;
