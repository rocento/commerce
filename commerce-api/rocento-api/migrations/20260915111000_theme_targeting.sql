ALTER TABLE theme.assignments ADD COLUMN rules jsonb NOT NULL DEFAULT '[]'
  CHECK (jsonb_typeof(rules) = 'array' AND jsonb_array_length(rules) <= 30);
