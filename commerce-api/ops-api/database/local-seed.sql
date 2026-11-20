-- Explicit local fixture only. Never run against staging or production.
INSERT INTO organizations(id,name) VALUES('00000000-0000-4000-8000-000000000001','Local development organization') ON CONFLICT DO NOTHING;
