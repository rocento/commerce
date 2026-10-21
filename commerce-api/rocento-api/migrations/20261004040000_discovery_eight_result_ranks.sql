-- Discovery returns up to eight products; observations must accept every served rank.
ALTER TABLE catalog.discovery_rank_observations
 DROP CONSTRAINT discovery_rank_observations_rank_check,
 ADD CONSTRAINT discovery_rank_observations_rank_check CHECK(rank BETWEEN 1 AND 8);
