-- Multi-market preparation is isolated from the live single-market checkout.
CREATE TABLE cart_checkout.market_drafts (
 id uuid PRIMARY KEY,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
 country text NOT NULL CHECK(country IN ('EG','US','SA','AE')),
 currency text NOT NULL CHECK(currency IN ('EGP','USD','SAR','AED')),
 locales text[] NOT NULL CHECK(cardinality(locales) BETWEEN 1 AND 20),
 default_locale text NOT NULL CHECK(default_locale = ANY(locales)),
 revision integer NOT NULL DEFAULT 1 CHECK(revision > 0),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE cart_checkout.market_overrides (
 market_id uuid NOT NULL REFERENCES cart_checkout.market_drafts(id) ON DELETE CASCADE,
 entity_type text NOT NULL CHECK(entity_type IN ('product','category','navigation')),
 entity_id uuid NOT NULL,
 available boolean,
 price numeric(12,2) CHECK(price >= 0),
 revision integer NOT NULL DEFAULT 1 CHECK(revision > 0),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(market_id,entity_type,entity_id),
 CHECK(entity_type='product' OR price IS NULL)
);
COMMENT ON TABLE cart_checkout.market_drafts IS 'Admin preparation only. Never used to price or route public checkout until market activation is implemented.';
