BEGIN;
CREATE TABLE evaluation.datasets (
 id uuid PRIMARY KEY,code text NOT NULL CHECK(length(code)>0),revision integer NOT NULL CHECK(revision>0),
 sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),reviewed_by text NOT NULL CHECK(length(trim(reviewed_by))>0),
 created_at timestamptz NOT NULL DEFAULT now(),transaction_id bigint NOT NULL DEFAULT txid_current(),
 UNIQUE(code,revision)
);
ALTER TABLE resolution.feedback
 ADD COLUMN tenant_id uuid,ADD COLUMN request_id uuid,ADD COLUMN input jsonb CHECK(input IS NULL OR jsonb_typeof(input)='object');
CREATE UNIQUE INDEX feedback_request_identity ON resolution.feedback(tenant_id,request_id) WHERE tenant_id IS NOT NULL AND request_id IS NOT NULL;
CREATE TABLE resolution.feedback_reviews (
 feedback_id bigint PRIMARY KEY REFERENCES resolution.feedback(id),
 decision text NOT NULL CHECK(decision IN ('approved','rejected')),
 reviewer text NOT NULL CHECK(length(trim(reviewer))>0),reason text NOT NULL CHECK(length(trim(reason))>0),
 corrected_case jsonb CHECK(corrected_case IS NULL OR jsonb_typeof(corrected_case)='object'),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((decision='approved')=(corrected_case IS NOT NULL))
);
CREATE VIEW resolution.feedback_queue AS SELECT f.*,coalesce(r.decision,'pending') AS review_status,r.reviewer,r.reason FROM resolution.feedback f LEFT JOIN resolution.feedback_reviews r ON r.feedback_id=f.id;
CREATE TABLE evaluation.cases (
 dataset_id uuid NOT NULL REFERENCES evaluation.datasets(id),case_key text NOT NULL CHECK(length(case_key)>0),
 definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object'),
 source_feedback_id bigint REFERENCES resolution.feedback_reviews(feedback_id),
 PRIMARY KEY(dataset_id,case_key)
);
CREATE TABLE evaluation.dataset_runs (
 evaluation_id uuid PRIMARY KEY REFERENCES release.evaluations(id),dataset_id uuid NOT NULL REFERENCES evaluation.datasets(id),
 dataset_sha256 text NOT NULL CHECK(dataset_sha256 ~ '^[a-f0-9]{64}$'),
 case_count integer NOT NULL CHECK(case_count>0),failure_count integer NOT NULL CHECK(failure_count BETWEEN 0 AND case_count),
 transaction_id bigint NOT NULL DEFAULT txid_current(),UNIQUE(evaluation_id,dataset_id)
);
CREATE TABLE evaluation.case_results (
 evaluation_id uuid NOT NULL,dataset_id uuid NOT NULL,case_key text NOT NULL,
 passed boolean NOT NULL,actual jsonb NOT NULL CHECK(jsonb_typeof(actual)='object'),
 mismatches jsonb NOT NULL CHECK(jsonb_typeof(mismatches)='array'),
 CHECK(passed=(jsonb_array_length(mismatches)=0)),
 PRIMARY KEY(evaluation_id,case_key),
 FOREIGN KEY(evaluation_id,dataset_id) REFERENCES evaluation.dataset_runs(evaluation_id,dataset_id),
 FOREIGN KEY(dataset_id,case_key) REFERENCES evaluation.cases(dataset_id,case_key)
);
CREATE FUNCTION evaluation.guard_case_membership() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM evaluation.datasets WHERE id=NEW.dataset_id AND transaction_id=txid_current()) THEN
  RAISE EXCEPTION 'Dataset cases must be created atomically with their immutable dataset';
 END IF;
 IF NEW.source_feedback_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM resolution.feedback_reviews
  WHERE feedback_id=NEW.source_feedback_id AND decision='approved' AND corrected_case=NEW.definition) THEN
  RAISE EXCEPTION 'Case does not match approved feedback correction';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER dataset_case_membership BEFORE INSERT ON evaluation.cases FOR EACH ROW EXECUTE FUNCTION evaluation.guard_case_membership();
CREATE FUNCTION evaluation.guard_result_membership() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM evaluation.dataset_runs WHERE evaluation_id=NEW.evaluation_id AND transaction_id=txid_current()) THEN
  RAISE EXCEPTION 'Case results must be created atomically with their immutable run';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER case_result_membership BEFORE INSERT ON evaluation.case_results FOR EACH ROW EXECUTE FUNCTION evaluation.guard_result_membership();
CREATE FUNCTION evaluation.set_transaction_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 NEW.transaction_id:=txid_current(); RETURN NEW;
END $$;
CREATE TRIGGER dataset_transaction BEFORE INSERT ON evaluation.datasets FOR EACH ROW EXECUTE FUNCTION evaluation.set_transaction_identity();
CREATE TRIGGER dataset_run_transaction BEFORE INSERT ON evaluation.dataset_runs FOR EACH ROW EXECUTE FUNCTION evaluation.set_transaction_identity();
CREATE FUNCTION evaluation.verify_complete_run() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE total integer; failed integer; BEGIN
 SELECT count(*),count(*) FILTER(WHERE NOT passed) INTO total,failed FROM evaluation.case_results WHERE evaluation_id=NEW.evaluation_id;
 IF total<>NEW.case_count OR failed<>NEW.failure_count
  OR total<>(SELECT count(*) FROM evaluation.cases WHERE dataset_id=NEW.dataset_id)
  OR NEW.dataset_sha256<>(SELECT sha256 FROM evaluation.datasets WHERE id=NEW.dataset_id)
  OR (failed>0 AND (SELECT passed FROM release.evaluations WHERE id=NEW.evaluation_id)) THEN
  RAISE EXCEPTION 'Dataset evaluation is incomplete or has inconsistent evidence';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER complete_dataset_run AFTER INSERT ON evaluation.dataset_runs
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION evaluation.verify_complete_run();
DO $$ DECLARE name text; BEGIN
 FOREACH name IN ARRAY ARRAY['evaluation.datasets','evaluation.cases','evaluation.dataset_runs','evaluation.case_results','resolution.feedback_reviews','resolution.feedback'] LOOP
  EXECUTE format('CREATE TRIGGER immutable_record BEFORE UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION release.reject_dictionary_mutation()',name);
 END LOOP;
END $$;
-- Feedback is operator-only. No customer inputs are exposed to language runtimes.
REVOKE ALL ON resolution.feedback,resolution.feedback_reviews,resolution.feedback_queue,evaluation.datasets,evaluation.cases,evaluation.dataset_runs,evaluation.case_results FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ai_language_runtime') THEN
  REVOKE ALL ON resolution.feedback,resolution.feedback_reviews,resolution.feedback_queue,evaluation.datasets,evaluation.cases,evaluation.dataset_runs,evaluation.case_results FROM ai_language_runtime;
 END IF;
END $$;
COMMIT;
