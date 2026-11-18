-- Staff choose an existing host before placement; allocator still owns reservations.
ALTER TABLE tenants ADD COLUMN preferred_host_id uuid;
ALTER TABLE tenants ADD CONSTRAINT tenant_preferred_host_provider
 FOREIGN KEY(preferred_host_id,hosting_provider) REFERENCES merchant_hosts(id,provider);
CREATE OR REPLACE FUNCTION reserve_merchant_host(job_uuid uuid, lease_uuid uuid, profile text,
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
 IF t.preferred_host_id IS NOT NULL THEN
   SELECT * INTO h FROM merchant_hosts mh WHERE mh.id=t.preferred_host_id
     AND provider=t.hosting_provider AND state IN ('REQUESTED','CREATING','BOOTING','READY')
     AND profile_digest=profile AND release_digest=j.artifact_digest
     AND (SELECT count(*) FROM merchant_placements WHERE host_id=mh.id)<3
     FOR UPDATE;
   -- An explicit choice must never silently move the merchant or create a VM.
   IF h.id IS NULL THEN RETURN NULL; END IF;
 ELSE
 SELECT * INTO h FROM merchant_hosts mh WHERE provider=t.hosting_provider
   AND state IN ('REQUESTED','CREATING','BOOTING','READY')
   AND profile_digest=profile AND release_digest=j.artifact_digest
   AND (SELECT count(*) FROM merchant_placements WHERE host_id=mh.id)<3
   ORDER BY (state='READY') DESC,created_at,id LIMIT 1 FOR UPDATE;
 END IF;
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
