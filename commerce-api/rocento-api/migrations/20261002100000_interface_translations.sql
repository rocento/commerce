-- Interface copy is a separate draft bundle; never update catalog text or publish implicitly.
CREATE TABLE cms.interface_translation_state (
 singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
 revision integer NOT NULL DEFAULT 1 CHECK (revision > 0)
);
INSERT INTO cms.interface_translation_state(singleton) VALUES(true);
CREATE TABLE cms.interface_translations (
 message_key text NOT NULL,
 locale text NOT NULL CHECK (locale IN ('en','ar')),
 form text NOT NULL CHECK (form IN ('zero','one','two','few','many','other')),
 text text NOT NULL CHECK (length(text) BETWEEN 1 AND 4000),
 source_text text NOT NULL,
 updated_by uuid NOT NULL REFERENCES admin_iam.admin_users(id),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(message_key,locale,form)
);
