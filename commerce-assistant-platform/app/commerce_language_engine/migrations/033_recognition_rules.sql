BEGIN;
-- Rule content belongs to an immutable dictionary release, including its hash.
-- This projection supports SQL inspection; edits are made through new drafts.
CREATE TABLE release.recognition_rules (
 release_id uuid NOT NULL REFERENCES release.dictionaries(id),
 code text NOT NULL,
 kind text NOT NULL CHECK (kind IN ('value','pattern','template')),
 definition jsonb NOT NULL CHECK (jsonb_typeof(definition)='object'),
 PRIMARY KEY (release_id,code),
 CHECK (definition->>'kind'=kind)
);
CREATE FUNCTION release.guard_recognition_rules() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF (SELECT artifact->'recognitionRules'->'entries'->NEW.code FROM release.dictionaries WHERE id=NEW.release_id) IS DISTINCT FROM NEW.definition THEN
   RAISE EXCEPTION 'Recognition rule differs from the immutable release artifact';
  END IF;
  RETURN NEW;
 END IF;
 RAISE EXCEPTION 'Recognition rules are immutable; create a new dictionary draft';
END;
$$;
CREATE TRIGGER immutable_recognition_rules BEFORE INSERT OR UPDATE OR DELETE ON release.recognition_rules
 FOR EACH ROW EXECUTE FUNCTION release.guard_recognition_rules();
COMMIT;
