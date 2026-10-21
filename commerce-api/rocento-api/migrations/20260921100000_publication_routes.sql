-- Explicit operator-reviewed route decisions only. A missing/deactivated product is NOT a tombstone.
CREATE TABLE platform.publication_routes (
 path text PRIMARY KEY CHECK (path ~ '^/(products|categories|pages)/[A-Za-z0-9_-]+$'),
 status integer NOT NULL CHECK(status IN (301,410)),
 target text,
 reason text NOT NULL CHECK(length(trim(reason)) > 0),
 approved_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((status=410 AND target IS NULL) OR
        (status=301 AND target ~ '^/(products|categories|pages)/[A-Za-z0-9_-]+$' AND target<>path))
);
