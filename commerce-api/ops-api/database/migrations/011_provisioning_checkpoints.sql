-- Stop and drain the worker before applying; never rewrite a live execution.
LOCK TABLE provisioning_jobs IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM provisioning_jobs WHERE status='RUNNING') THEN
   RAISE EXCEPTION 'PROVISIONING_WORKER_MUST_BE_DRAINED';
 END IF;
END $$;
ALTER TABLE provisioning_jobs DROP CONSTRAINT provisioning_jobs_step_check;
UPDATE provisioning_jobs SET step='DATABASE' WHERE step='DEPLOY';
ALTER TABLE provisioning_jobs ADD CONSTRAINT provisioning_jobs_step_check
 CHECK(step IN ('RELEASE','ALLOCATE','DATABASE','MIGRATE','SERVICES','BOOTSTRAP','INGRESS','VALIDATE','DONE'));
-- Historical DEPLOY evidence stays immutable. Already validated legacy deployments
-- can finish; new executions must provide every individual checkpoint.
ALTER TABLE provisioning_steps DROP CONSTRAINT provisioning_steps_step_check;
ALTER TABLE provisioning_steps ADD CONSTRAINT provisioning_steps_step_check
 CHECK(step IN ('RELEASE','ALLOCATE','DEPLOY','DATABASE','MIGRATE','SERVICES','BOOTSTRAP','INGRESS','VALIDATE'));
