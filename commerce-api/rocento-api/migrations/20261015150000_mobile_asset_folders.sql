-- Logical folders are merchant-owned; moving/deleting them never changes image URLs.
CREATE TABLE mobile.asset_folders (
    id uuid PRIMARY KEY,
    merchant_id uuid NOT NULL REFERENCES mobile.merchants(id) ON DELETE CASCADE,
    parent_id uuid,
    name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
    UNIQUE (merchant_id, id),
    FOREIGN KEY (merchant_id, parent_id) REFERENCES mobile.asset_folders(merchant_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX mobile_asset_folder_names ON mobile.asset_folders(merchant_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));
ALTER TABLE mobile.assets ADD COLUMN folder_id uuid;
ALTER TABLE mobile.assets ADD CONSTRAINT mobile_asset_folder_owner FOREIGN KEY (merchant_id, folder_id) REFERENCES mobile.asset_folders(merchant_id, id) ON DELETE SET NULL (folder_id);
CREATE INDEX mobile_assets_folder ON mobile.assets(merchant_id, folder_id);
