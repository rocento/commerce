SELECT c.ordinal,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('rule_id',e.rule_id,'period',e.period,'dimension',e.dimension,'limit',e.maximum,
   'effective',e.maximum*(100+e.overflow_percent)/100,'used',CASE WHEN e.missing>0 THEN 9223372036854775807 ELSE e.used END,
   'remaining',CASE WHEN e.missing>0 THEN 0 ELSE GREATEST(0,e.maximum*(100+e.overflow_percent)/100-e.used) END)) FROM evaluated e WHERE e.ordinal=c.ordinal),'[]'::jsonb) caps,
 (SELECT COUNT(*) FROM fulfillment.capacity_reservations r WHERE r.schedule_id=c.schedule_id AND r.starts_at=c.starts_at AND r.ends_at=c.ends_at AND r.status='HELD' AND r.expires_at>clock_timestamp()) held,
 (SELECT COUNT(*) FROM fulfillment.capacity_reservations r WHERE r.schedule_id=c.schedule_id AND r.starts_at=c.starts_at AND r.ends_at=c.ends_at AND r.status='CONFIRMED') confirmed
FROM candidates c ORDER BY c.ordinal
