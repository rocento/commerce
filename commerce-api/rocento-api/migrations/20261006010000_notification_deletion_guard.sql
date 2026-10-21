-- Preserve immutable content while allowing withdrawal and terminal soft deletion.
CREATE OR REPLACE FUNCTION platform.protect_storefront_notification_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (to_jsonb(NEW) - ARRAY['withdrawn_at','withdrawn_by','deleted_at','version']) IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['withdrawn_at','withdrawn_by','deleted_at','version'])
       OR OLD.deleted_at IS NOT NULL
       OR NEW.withdrawn_at IS NULL OR NEW.withdrawn_by IS NULL
       OR NEW.version <> OLD.version + 1
       OR (OLD.withdrawn_at IS NOT NULL AND
           (NEW.deleted_at IS NULL OR NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at
            OR NEW.withdrawn_by IS DISTINCT FROM OLD.withdrawn_by)) THEN
        RAISE EXCEPTION 'Published storefront notification snapshots are immutable';
    END IF;
    RETURN NEW;
END;
$$;
