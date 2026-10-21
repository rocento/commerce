ALTER TABLE mobile.preview_sessions ADD COLUMN implementation text NOT NULL DEFAULT 'native'
    CHECK (implementation IN ('native', 'react-native'));
