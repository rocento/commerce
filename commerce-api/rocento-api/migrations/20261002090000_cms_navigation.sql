ALTER TABLE cms.documents DROP CONSTRAINT documents_kind_check;
ALTER TABLE cms.documents DROP CONSTRAINT documents_check;
ALTER TABLE cms.documents ADD CONSTRAINT documents_kind_check CHECK(kind IN ('home','page','footer','navigation'));
ALTER TABLE cms.documents ADD CONSTRAINT documents_check CHECK(
 (kind='home' AND key='home') OR (kind='footer' AND key='footer') OR
 (kind='navigation' AND key='navigation') OR
 (kind='page' AND key NOT IN ('home','footer','navigation')));
