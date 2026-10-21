-- AI-owned unstructured knowledge only. Applied by the database owner.
CREATE TABLE IF NOT EXISTS assistant.knowledge_sources (
 tenant_id uuid NOT NULL, id uuid NOT NULL, revision bigint NOT NULL CHECK(revision>0),
 metadata jsonb NOT NULL, digest text NOT NULL, model text NOT NULL,
 approved boolean NOT NULL, collection text NOT NULL, language text NOT NULL, kind text NOT NULL,
 personas text[] NOT NULL, permissions text[] NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,id),
 CHECK(kind IN ('faq','policy','size_guide','buying_guide','imported'))
);
CREATE TABLE IF NOT EXISTS assistant.knowledge_chunks (
 tenant_id uuid NOT NULL, source_id uuid NOT NULL, id text NOT NULL,
 page integer NOT NULL CHECK(page>0), ordinal integer NOT NULL CHECK(ordinal>=0 AND ordinal<128),
 body text NOT NULL CHECK(length(body)>0 AND length(body)<=1200), embedding vector(1536) NOT NULL,
 PRIMARY KEY(tenant_id,source_id,id),
 FOREIGN KEY(tenant_id,source_id) REFERENCES assistant.knowledge_sources(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS knowledge_filter ON assistant.knowledge_sources(tenant_id,collection,model) WHERE approved;
CREATE INDEX IF NOT EXISTS knowledge_embedding ON assistant.knowledge_chunks USING hnsw (embedding vector_cosine_ops);
ALTER TABLE assistant.knowledge_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant.knowledge_sources FORCE ROW LEVEL SECURITY;
ALTER TABLE assistant.knowledge_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant.knowledge_chunks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS knowledge_tenant ON assistant.knowledge_sources;
CREATE POLICY knowledge_tenant ON assistant.knowledge_sources USING (
 tenant_id=(SELECT tenant_id FROM assistant.deployment WHERE singleton)
 AND tenant_id=current_setting('assistant.tenant',true)::uuid
);
DROP POLICY IF EXISTS knowledge_tenant ON assistant.knowledge_chunks;
CREATE POLICY knowledge_tenant ON assistant.knowledge_chunks USING (
 tenant_id=(SELECT tenant_id FROM assistant.deployment WHERE singleton)
 AND tenant_id=current_setting('assistant.tenant',true)::uuid
);
REVOKE ALL ON assistant.knowledge_sources,assistant.knowledge_chunks FROM ai_runtime;
GRANT SELECT ON assistant.knowledge_sources,assistant.knowledge_chunks TO ai_runtime;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='ai_knowledge_writer') THEN
  CREATE ROLE ai_knowledge_writer NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
 END IF;
END $$;
GRANT USAGE ON SCHEMA assistant TO ai_knowledge_writer;
GRANT SELECT ON assistant.deployment TO ai_knowledge_writer;
GRANT SELECT,INSERT,UPDATE,DELETE ON assistant.knowledge_sources,assistant.knowledge_chunks TO ai_knowledge_writer;
ALTER ROLE ai_knowledge_writer SET statement_timeout='5000ms';
ALTER ROLE ai_knowledge_writer CONNECTION LIMIT 2;

-- pgvector lives in public; USAGE permits its types/operators, never object creation.
GRANT USAGE ON SCHEMA public TO ai_runtime,ai_knowledge_writer;
REVOKE CREATE ON SCHEMA public FROM ai_runtime,ai_knowledge_writer;
