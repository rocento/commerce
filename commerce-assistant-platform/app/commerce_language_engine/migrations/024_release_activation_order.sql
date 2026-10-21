BEGIN;
-- Apply only the activation whose expected predecessor is still current. A
-- transaction may record several intents, but may not replay a stale intent.
CREATE OR REPLACE FUNCTION release.validate_activation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_id uuid; approved boolean;
BEGIN
 IF NEW.operation IS NULL OR coalesce(length(NEW.actor),0)=0 OR coalesce(length(NEW.reason),0)=0 THEN
  RAISE EXCEPTION 'activation requires explicit lifecycle operation, actor and reason';
 END IF;
 PERFORM pg_advisory_xact_lock(57439);
 NEW.transaction_id := txid_current();
 SELECT release_id INTO current_id FROM release.channels WHERE channel=NEW.channel;
 IF current_id IS DISTINCT FROM NEW.previous_release_id THEN RAISE EXCEPTION 'active release changed'; END IF;
 IF NEW.operation='promotion' THEN
  SELECT e.passed AND e.release_id=NEW.release_id AND c.base_release_id IS NOT DISTINCT FROM current_id
   AND e.artifact_sha256=c.artifact_sha256 AND e.corpus_sha256=c.corpus_sha256
  INTO approved FROM release.evaluations e JOIN release.candidates c ON c.release_id=e.release_id WHERE e.id=NEW.evaluation_id;
  IF approved IS DISTINCT FROM true THEN RAISE EXCEPTION 'promotion requires exact passing candidate evidence and current base'; END IF;
 ELSIF NEW.operation='bootstrap' THEN
  IF current_id IS NOT NULL OR EXISTS(SELECT 1 FROM release.activations) THEN RAISE EXCEPTION 'bootstrap requires a never-activated database'; END IF;
 ELSIF NEW.operation='rollback' THEN
  IF NOT EXISTS(SELECT 1 FROM release.baselines WHERE release_id=NEW.release_id) AND NOT EXISTS(SELECT 1 FROM release.activations WHERE release_id=NEW.release_id AND operation IN ('promotion','bootstrap')) THEN RAISE EXCEPTION 'rollback target has no baseline or approved activation'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION release.validate_channel_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_id uuid;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'release channels cannot be deleted'; END IF;
 IF TG_OP='UPDATE' AND NEW.channel IS DISTINCT FROM OLD.channel THEN RAISE EXCEPTION 'release channel identity is immutable'; END IF;
 SELECT release_id INTO current_id FROM release.channels WHERE channel=NEW.channel;
 IF NOT EXISTS(SELECT 1 FROM release.activations WHERE channel=NEW.channel AND release_id=NEW.release_id
   AND transaction_id=txid_current() AND previous_release_id IS NOT DISTINCT FROM current_id) THEN
  RAISE EXCEPTION 'channel changes require a gated activation with the current predecessor in the same transaction';
 END IF;
 RETURN NEW;
END $$;
-- Freeze and direct membership inserts share the same draft lock. The check
-- runs after the lock, so an insertion waiting on freeze sees its committed row.
CREATE OR REPLACE FUNCTION release.guard_frozen_draft() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext(NEW.draft_id::text));
 IF EXISTS(SELECT 1 FROM release.candidates WHERE draft_id=NEW.draft_id AND draft_revision=NEW.revision) THEN RAISE EXCEPTION 'frozen draft membership is immutable'; END IF;
 RETURN NEW;
END $$;
COMMIT;
