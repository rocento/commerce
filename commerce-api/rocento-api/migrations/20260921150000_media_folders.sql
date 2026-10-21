CREATE TABLE catalog.media_folders (
 id uuid PRIMARY KEY,
 name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100 AND name !~ '[/\\]' AND name NOT IN ('.','..')),
 parent_id uuid REFERENCES catalog.media_folders(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK (parent_id IS DISTINCT FROM id)
);
CREATE UNIQUE INDEX media_folder_sibling_name ON catalog.media_folders(COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));
ALTER TABLE catalog.media ADD COLUMN folder_id uuid REFERENCES catalog.media_folders(id) ON DELETE SET NULL;
ALTER TABLE catalog.media ADD COLUMN file_name text NOT NULL DEFAULT '';
CREATE INDEX media_folder_contents ON catalog.media(folder_id, created_at DESC, id);
-- Preserve the organizational paths previously displayed by the media library.
DO $$
DECLARE item record; segment text; parent uuid; folder uuid;
BEGIN
 FOR item IN SELECT DISTINCT regexp_replace(object_key, '/[^/]+$', '') AS path FROM catalog.media WHERE object_key LIKE '%/%' LOOP
  parent := NULL;
  FOREACH segment IN ARRAY string_to_array(item.path, '/') LOOP
   IF segment = '' OR segment IN ('.','..') OR length(segment) > 100 OR position(chr(92) in segment) > 0 THEN parent := NULL; EXIT; END IF;
   SELECT id INTO folder FROM catalog.media_folders WHERE parent_id IS NOT DISTINCT FROM parent AND lower(name)=lower(segment);
   IF folder IS NULL THEN
    folder := gen_random_uuid();
    INSERT INTO catalog.media_folders(id,name,parent_id) VALUES(folder,segment,parent);
   END IF;
   parent := folder;
  END LOOP;
  UPDATE catalog.media SET folder_id=parent WHERE regexp_replace(object_key, '/[^/]+$', '')=item.path;
 END LOOP;
END $$;
