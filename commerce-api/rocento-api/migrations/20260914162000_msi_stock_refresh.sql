-- Preserve the applied M12 migration and extend it without rewriting history.
ALTER TABLE inventory.source_items DROP CONSTRAINT source_items_quantity_check;
ALTER TABLE inventory.source_items ADD CONSTRAINT source_items_quantity_check CHECK(quantity>=0);

-- Quantity writes touch only the affected product; source/pool configuration may refresh all.
CREATE FUNCTION inventory.refresh_stock_product(p uuid) RETURNS void LANGUAGE SQL AS $$
 UPDATE inventory.stock s SET on_hand=COALESCE((
  SELECT SUM(i.quantity)::integer FROM inventory.source_items i
  JOIN inventory.inventory_sources src ON src.id=i.source_id AND src.is_enabled
  JOIN inventory.source_stock_links l ON l.source_id=i.source_id
  JOIN inventory.stocks st ON st.id=l.stock_id AND st.is_default
  WHERE i.product_id=s.product_id AND i.status='in_stock'
 ),0),updated_at=clock_timestamp() WHERE s.product_id=p;
$$;

