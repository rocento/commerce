ALTER TABLE mobile.preview_sessions ADD COLUMN platform text NOT NULL DEFAULT 'ios' CHECK (platform IN ('ios','android'));
