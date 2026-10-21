-- Backfill the new search facet through the existing durable product event consumer.
INSERT INTO platform.outbox(id,event_type,payload)
SELECT gen_random_uuid(),'inventory.stock_updated',jsonb_build_object('id',id) FROM catalog.products;
