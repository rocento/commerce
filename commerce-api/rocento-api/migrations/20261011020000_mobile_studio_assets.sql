-- Private immutable uploads for App Studio. Existing trusted HTTPS records remain valid.
ALTER TABLE mobile.assets ALTER COLUMN url DROP NOT NULL;
ALTER TABLE mobile.assets ADD COLUMN object_key text;
ALTER TABLE mobile.assets ADD COLUMN name text NOT NULL DEFAULT 'Image';
ALTER TABLE mobile.assets ADD COLUMN content_type text;
ALTER TABLE mobile.assets ADD COLUMN width integer;
ALTER TABLE mobile.assets ADD COLUMN height integer;
ALTER TABLE mobile.assets ADD COLUMN size_bytes bigint;
ALTER TABLE mobile.assets ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE mobile.assets ADD CONSTRAINT mobile_asset_storage CHECK (
 (object_key IS NULL AND url IS NOT NULL) OR
 (object_key IS NOT NULL AND url IS NULL AND content_type IS NOT NULL AND content_type='image/png'
  AND width IS NOT NULL AND height IS NOT NULL AND size_bytes IS NOT NULL
  AND width BETWEEN 1 AND 4096 AND height BETWEEN 1 AND 4096
  AND size_bytes BETWEEN 1 AND 5242880)
);
CREATE INDEX mobile_assets_merchant ON mobile.assets(merchant_id,id DESC);
