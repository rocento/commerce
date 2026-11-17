-- Expand accepted plans without changing existing merchant selections.
ALTER TABLE tenants DROP CONSTRAINT tenants_plan_id_check;
ALTER TABLE tenants ADD CONSTRAINT tenants_plan_id_check
    CHECK (plan_id IN ('STARTER', 'LAUNCH', 'GROWTH', 'ENTERPRISE'));

ALTER TABLE onboarding_drafts DROP CONSTRAINT onboarding_drafts_plan_check;
ALTER TABLE onboarding_drafts ADD CONSTRAINT onboarding_drafts_plan_check
    CHECK (plan IN ('STARTER', 'LAUNCH', 'GROWTH', 'ENTERPRISE'));
