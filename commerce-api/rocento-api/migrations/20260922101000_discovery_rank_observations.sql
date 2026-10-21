-- One latest observation per public product; no query, customer, session or profile data.
CREATE TABLE catalog.discovery_rank_observations (
 product_id uuid PRIMARY KEY REFERENCES catalog.products(id) ON DELETE CASCADE,
 ranker text NOT NULL,
 rank integer NOT NULL CHECK(rank BETWEEN 1 AND 5),
 score integer NOT NULL CHECK(score BETWEEN -100000 AND 100000),
 contributions jsonb NOT NULL CHECK(jsonb_typeof(contributions)='array' AND jsonb_array_length(contributions)<=10),
 sponsored boolean NOT NULL,
 merchant_boost integer NOT NULL CHECK(merchant_boost BETWEEN 0 AND 10),
 observed_at timestamptz NOT NULL DEFAULT now()
);
