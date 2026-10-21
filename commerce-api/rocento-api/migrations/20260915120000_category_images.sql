-- Standard category images use the existing validated media attribute storage.
INSERT INTO attributes.definitions
    (id, entity_type, attribute_code, label, input_type, is_visible_on_front)
VALUES
    ('d9f7a7a3-2f84-4c90-8b8e-c35596351301', 'category', 'thumbnail', 'Thumbnail', 'media_image', true),
    ('d9f7a7a3-2f84-4c90-8b8e-c35596351302', 'category', 'banner', 'Banner', 'media_image', true)
ON CONFLICT (entity_type, attribute_code) DO NOTHING;
