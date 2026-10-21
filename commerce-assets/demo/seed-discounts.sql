-- Opt-in grocery demo fixture. Never run automatically during deployment/migrations.
BEGIN;
SELECT pg_advisory_xact_lock(3003);
CREATE TEMP TABLE discount_demo ON COMMIT DROP AS
SELECT p.id,p.sku,p.name,p.price,p.currency,
 md5('discount-demo:v1:'||p.sku)::uuid AS rule_id,
 (35-row_number() OVER(ORDER BY p.sku,p.id)*5)::numeric AS percentage
FROM (SELECT * FROM catalog.products WHERE active AND price>0 AND parent_id IS NULL
      AND sku LIKE 'DEMO-GRO-%' ORDER BY sku,id LIMIT 5) p;
DO $$ BEGIN
 IF (SELECT count(*) FROM discount_demo)<>5 THEN
  RAISE EXCEPTION 'Expected five grocery demo products; seed the grocery preset first';
 END IF;
 IF (SELECT count(*) FROM pricing_promotions.rules)+(SELECT count(*) FROM discount_demo d WHERE NOT EXISTS(SELECT 1 FROM pricing_promotions.rules r WHERE r.id=d.rule_id))>100 THEN
  RAISE EXCEPTION 'Demo discounts would exceed the promotion rule limit';
 END IF;
END $$;
INSERT INTO pricing_promotions.rules(id,name,scope,kind,value,min_subtotal,skus,category_ids,customer_group,priority,active,starts_at,ends_at)
SELECT rule_id,'DEMO discount — '||name,'catalog','percentage',percentage,0,ARRAY[sku],'{}'::uuid[],'all',0,true,now()-interval '1 minute',now()+interval '30 days'
FROM discount_demo
ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,value=EXCLUDED.value,active=true,
 starts_at=EXCLUDED.starts_at,ends_at=EXCLUDED.ends_at,updated_at=clock_timestamp();
SELECT json_build_object('demo',true,'expires_in_days',30,'products',json_agg(json_build_object(
 'sku',d.sku,'name',d.name,'original_price',d.price,'currency',d.currency,
 'discount_percent',r.value,'discounted_price',d.price-round(d.price*r.value/100,2)) ORDER BY r.value DESC))
FROM discount_demo d JOIN pricing_promotions.rules r ON r.id=d.rule_id;
COMMIT;
