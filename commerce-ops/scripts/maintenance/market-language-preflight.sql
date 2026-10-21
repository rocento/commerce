-- Read-only preflight for 20261002190000; run after 20261002180000.
-- Every violations count must be zero. Investigate data; do not silently normalize it.
BEGIN READ ONLY;
WITH locale_values AS (
 SELECT 'storefront_languages' AS source,locale FROM cms.storefront_languages
 UNION ALL SELECT 'language_settings',source_locale FROM cms.language_settings
 UNION ALL SELECT 'navigation_release_translations',locale FROM cms.navigation_release_translations
 UNION ALL SELECT 'market_releases',source_locale FROM cart_checkout.market_releases
)
SELECT source AS check_name,count(*) AS violations FROM locale_values
 WHERE NOT(locale ~ '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$')
 GROUP BY source
UNION ALL
SELECT 'market_draft_locales',count(*) FROM cart_checkout.market_drafts m
 WHERE NOT coalesce((SELECT array_ndims(m.locales)=1
   AND cardinality(m.locales) BETWEEN 1 AND 20
   AND cardinality(m.locales)=count(DISTINCT locale)
   AND bool_and(locale ~ '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$')
   FROM unnest(m.locales) l(locale)),false)
 OR NOT(default_locale ~ '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$')
UNION ALL
SELECT 'market_release_revision',count(*) FROM cart_checkout.market_releases WHERE draft_revision<=0
UNION ALL
SELECT 'market_release_actor',count(*) FROM cart_checkout.market_releases r
 WHERE NOT EXISTS(SELECT 1 FROM admin_iam.admin_users u WHERE u.id=r.created_by)
UNION ALL
SELECT 'active_market_revision',count(*) FROM cart_checkout.active_market WHERE revision<=0
ORDER BY check_name;
COMMIT;
