-- Global delivery is an explicit, inherited store policy; existing coverage stays local.
CREATE FUNCTION fulfillment.global_delivery(store uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT COALESCE((s.capabilities->>'global_delivery_enabled')::boolean,(d.capabilities->>'global_delivery_enabled')::boolean,false)
 AND COALESCE((s.capabilities->>'delivery_enabled')::boolean,(d.capabilities->>'delivery_enabled')::boolean,true)
 FROM fulfillment.stores s CROSS JOIN fulfillment.system_capabilities d WHERE s.id=store
$$;
CREATE FUNCTION fulfillment.cart_global_delivery(cart uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT fulfillment.global_delivery(c.fulfillment_store_id) FROM cart_checkout.carts c WHERE c.id=cart
$$;
CREATE OR REPLACE FUNCTION fulfillment.geofencing(store uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT COALESCE((s.capabilities->>'geo_fencing_enabled')::boolean,(d.capabilities->>'geo_fencing_enabled')::boolean,true)
 AND NOT fulfillment.global_delivery(store)
 FROM fulfillment.stores s CROSS JOIN fulfillment.system_capabilities d WHERE s.id=store
$$;
