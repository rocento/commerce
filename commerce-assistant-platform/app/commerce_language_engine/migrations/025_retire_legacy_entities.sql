BEGIN;
LOCK TABLE entity_legacy.terms,entity_legacy.aliases IN ACCESS EXCLUSIVE MODE;
-- Forward-only retirement: never silently discard records on another installation.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM entity_legacy.terms) OR EXISTS(SELECT 1 FROM entity_legacy.aliases) THEN
  RAISE EXCEPTION 'Legacy entity tables contain records; reconcile them before retirement';
 END IF;
END $$;
DROP TABLE entity_legacy.aliases;
DROP TABLE entity_legacy.terms;
DROP SCHEMA entity_legacy;
COMMIT;
