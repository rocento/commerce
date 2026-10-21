-- Draft content never changes live delivery until a publication is committed.
CREATE TABLE platform.email_templates (
    key text PRIMARY KEY CHECK (key IN ('verify','reset','order','shipment')),
    id uuid NOT NULL UNIQUE,
    draft_content jsonb CHECK (draft_content IS NULL OR jsonb_typeof(draft_content) = 'object'),
    revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
    published_version bigint,
    updated_at timestamptz,
    updated_by uuid
);
CREATE TABLE platform.email_template_versions (
    template_key text NOT NULL REFERENCES platform.email_templates(key),
    version bigint NOT NULL CHECK (version > 0),
    content jsonb NOT NULL CHECK (jsonb_typeof(content) = 'object'),
    change_note text NOT NULL CHECK (char_length(change_note) BETWEEN 3 AND 500),
    published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    -- Preserve attribution even if an administrator is removed later.
    published_by uuid NOT NULL,
    PRIMARY KEY (template_key, version)
);
ALTER TABLE platform.email_templates ADD CONSTRAINT email_template_publication
    FOREIGN KEY (key, published_version)
    REFERENCES platform.email_template_versions(template_key, version);

CREATE FUNCTION platform.protect_email_template_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Published email template versions are immutable';
END;
$$;
CREATE TRIGGER email_template_history_immutable BEFORE UPDATE OR DELETE
    ON platform.email_template_versions FOR EACH ROW
    EXECUTE FUNCTION platform.protect_email_template_history();

-- NULL content uses the versioned application defaults; no mail delivery is disabled.
INSERT INTO platform.email_templates(key,id) VALUES
    ('verify','e0000000-0000-4000-8000-000000000001'),
    ('reset','e0000000-0000-4000-8000-000000000002'),
    ('order','e0000000-0000-4000-8000-000000000003'),
    ('shipment','e0000000-0000-4000-8000-000000000004');
