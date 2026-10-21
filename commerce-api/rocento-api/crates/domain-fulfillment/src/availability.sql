SELECT c.ordinal,COALESCE(bool_and(e.known AND e.missing=0 AND e.used+e.need<=e.maximum*(100+e.overflow_percent)/100),true) available,
 COALESCE(bool_or(e.used+e.need>=e.maximum*0.9),false) limited
FROM candidates c LEFT JOIN evaluated e ON e.ordinal=c.ordinal GROUP BY c.ordinal ORDER BY c.ordinal
