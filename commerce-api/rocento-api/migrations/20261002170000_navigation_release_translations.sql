-- Freeze reviewed translations with the release: later draft edits stay private.
CREATE TABLE cms.navigation_release_translations (
 release_id uuid NOT NULL REFERENCES cms.releases(id) ON DELETE CASCADE,
 locale text NOT NULL,
 fields jsonb NOT NULL CHECK (jsonb_typeof(fields) = 'object'),
 PRIMARY KEY (release_id, locale)
);
