-- Existing suggestions remain visible/rejectable, but require regeneration before approval.
ALTER TABLE attributes.enrichment_suggestions
 ADD COLUMN evidence jsonb,
 ADD COLUMN basis jsonb,
 ADD COLUMN definition_version integer;
CREATE INDEX enrichment_review_page
 ON attributes.enrichment_suggestions(created_at DESC,id DESC);
CREATE INDEX enrichment_product_review
 ON attributes.enrichment_suggestions(product_id,definition_id,created_at DESC);
