-- Independent commerce identity; deliberately unrelated to assistant tenant identity.
CREATE TABLE platform.publication_installation (
 singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
 installation_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid()
);
INSERT INTO platform.publication_installation(singleton) VALUES (true);
