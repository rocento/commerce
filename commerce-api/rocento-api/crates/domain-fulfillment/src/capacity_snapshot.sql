-- One set-based capacity read for every generated candidate. Admission still locks and rechecks.
WITH candidates AS (
 SELECT row_number() OVER ()-1 AS ordinal,* FROM jsonb_to_recordset($1::jsonb)
 AS s(schedule_id uuid,source_id uuid,area_id uuid,method text,starts_at timestamptz,ends_at timestamptz)
), constraints AS (
 SELECT c.ordinal,r.*,d.key dimension,d.value::bigint maximum,
   CASE WHEN r.period='slot' THEN c.starts_at ELSE t.local_start AT TIME ZONE r.timezone END lo,
   CASE WHEN r.period='slot' THEN c.ends_at ELSE (t.local_start+CASE WHEN r.period='day' THEN interval '1 day' ELSE interval '1 hour' END) AT TIME ZONE r.timezone END hi
 FROM candidates c JOIN fulfillment.capacity_rules r ON r.enabled
 AND NOT EXISTS(SELECT 1 FROM fulfillment.capacity_rules o WHERE o.enabled AND o.overrides_rule_id=r.id
   AND o.starts_on<=(c.starts_at AT TIME ZONE o.timezone)::date AND o.ends_on>=(c.starts_at AT TIME ZONE o.timezone)::date
   AND (o.local_start IS NULL OR o.local_start=(c.starts_at AT TIME ZONE o.timezone)::time))
 AND (r.source_id IS NULL OR r.source_id=c.source_id) AND (r.area_id IS NULL OR r.area_id=COALESCE(c.area_id,$2))
 AND (r.method IS NULL OR r.method=c.method)
 AND (r.starts_on IS NULL OR r.starts_on<=(c.starts_at AT TIME ZONE r.timezone)::date)
 AND (r.ends_on IS NULL OR r.ends_on>=(c.starts_at AT TIME ZONE r.timezone)::date)
 AND (r.local_start IS NULL OR r.local_start=(c.starts_at AT TIME ZONE r.timezone)::time)
 CROSS JOIN LATERAL jsonb_each_text(r.limits) d
 CROSS JOIN LATERAL generate_series(
   date_trunc(CASE WHEN r.period='slot' THEN 'day' ELSE r.period END,c.starts_at AT TIME ZONE r.timezone),
   date_trunc(CASE WHEN r.period='slot' THEN 'day' ELSE r.period END,(CASE WHEN r.period='slot' THEN c.starts_at ELSE c.ends_at-interval '1 microsecond' END) AT TIME ZONE r.timezone),
   CASE WHEN r.period='hour' THEN interval '1 hour' ELSE interval '1 day' END) t(local_start)
), evaluated AS (
 SELECT x.ordinal,x.id rule_id,x.period,x.dimension,x.maximum,x.overflow_percent,
   COALESCE(($3::jsonb->>x.dimension)::bigint,0) need,
   $3::jsonb ? x.dimension known,
   COALESCE(SUM((r.requirement->>x.dimension)::bigint),0) used,
   COUNT(r.id) FILTER(WHERE NOT r.requirement ? x.dimension) missing
 FROM constraints x LEFT JOIN fulfillment.capacity_reservations r ON
 r.status IN ('HELD','CONFIRMED') AND tstzrange(r.starts_at,r.ends_at,'[)') && tstzrange(x.lo,x.hi,'[)') AND ($4::uuid IS NULL OR r.id<>$4)
 AND (x.source_id IS NULL OR r.source_id=x.source_id)
 AND (x.area_id IS NULL OR r.area_id=x.area_id) AND (x.method IS NULL OR r.method=x.method)
 AND (r.status='CONFIRMED' OR (r.status='HELD' AND r.expires_at>clock_timestamp()))
 GROUP BY x.ordinal,x.id,x.period,x.lo,x.hi,x.dimension,x.maximum,x.overflow_percent
)
