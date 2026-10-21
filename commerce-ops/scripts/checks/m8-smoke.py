"""M8 local accuracy, idempotency, bounded load and observability checks. Seeds persist for demo."""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

import argparse
import atexit
import hashlib
import concurrent.futures as futures
import datetime as dt
import json
import time
import threading
import urllib.error
import urllib.request
import uuid
from decimal import Decimal
from m8_db import pg,ch
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--gateway',default='http://localhost:8080')
p.add_argument('--events',type=int,default=2000)
p.add_argument('--observability',action='store_true')
a=p.parse_args()
assert a.gateway in ['http://localhost:8080','http://localhost:8081'], 'Local gateway only'
assert 1<=a.events<=50000
# An ephemeral reports-only session avoids consuming an operator's login rate limit.
# The account has no usable password and is deleted even when an assertion fails.
role,user,token=(str(uuid.uuid4()) for _ in range(3))
pg(f"INSERT INTO admin_iam.roles(id,name,permissions) VALUES('{role}','M8 smoke {role}',ARRAY['reports.read']); INSERT INTO admin_iam.admin_users(id,email,name,password_hash,role_id) VALUES('{user}','m8-smoke-{user}@example.test','M8 smoke','!NO-LOGIN','{role}'); INSERT INTO admin_iam.sessions(token_hash,admin_id,expires_at) VALUES('{hashlib.sha256(token.encode()).hexdigest()}','{user}',now()+interval '10 minutes');")
atexit.register(lambda:pg(f"DELETE FROM admin_iam.sessions WHERE admin_id='{user}'; DELETE FROM admin_iam.admin_users WHERE id='{user}'; DELETE FROM admin_iam.roles WHERE id='{role}';"))
class ReportClient:
    def call(self,method,path):
        request=urllib.request.Request(a.gateway+path,method=method,headers={'Cookie':'admin_session='+token})
        with urllib.request.urlopen(request,timeout=20) as response:return json.load(response)
admin=ReportClient()
today=dt.datetime.now(dt.timezone.utc).date()
start=today-dt.timedelta(days=365)
end=today.replace(day=1)-dt.timedelta(days=1)

def report(start=start,end=end):
    return admin.call('GET',f'/v1/admin/reports/dashboard?from={start}&to={end}')
def get(url):
    with urllib.request.urlopen(url,timeout=20) as r:return r.read()
def event(event_id=None,session=None):
    payload={'id':event_id or str(uuid.uuid4()),'session_id':session or str(uuid.uuid4()),'event_type':'page_view','path':'/','source':'direct'}
    req=urllib.request.Request(a.gateway+'/v1/analytics/events',data=json.dumps(payload).encode(),headers={'Content-Type':'application/json','X-Commerce-Request':'1'})
    start=time.perf_counter()
    with urllib.request.urlopen(req,timeout=20) as r:assert r.status==201
    return time.perf_counter()-start

def rejected(code,path):
    try:admin.call('GET',path)
    except urllib.error.HTTPError as e:assert e.code==code,(e.code,e.read())
    else:raise AssertionError('Expected rejection')
rejected(400,'/v1/admin/reports/dashboard?from=2020-01-01&to=2026-01-01')
try:get(a.gateway+f'/v1/admin/reports/dashboard?from={start}&to={today}')
except urllib.error.HTTPError as e:assert e.code==401
else:raise AssertionError('Unauthenticated report allowed')
r=report()
assert r['run']['age_seconds']<3600,r['run']
expected=json.loads(pg(f"SELECT json_build_object('orders',count(*) FILTER(WHERE o.status NOT IN ('cancelled','delivery_failed')),'cancelled',count(*) FILTER(WHERE o.status IN ('cancelled','delivery_failed')),'gross',coalesce(sum(o.total) FILTER(WHERE o.status NOT IN ('cancelled','delivery_failed')),0)::text,'refunds',coalesce(sum(r.amount),0)::text) FROM orders.orders o LEFT JOIN payments.manual_refunds r ON r.order_id=o.id WHERE (o.created_at AT TIME ZONE 'UTC')::date BETWEEN '{start}' AND '{end}';"))
assert sum(d['orders'] for d in r['sales'])==expected['orders']
assert sum(d['cancelled'] for d in r['sales'])==expected['cancelled']
assert sum(Decimal(d['gross']) for d in r['sales'])==Decimal(expected['gross'])
assert sum(Decimal(d['refunds']) for d in r['sales'])==Decimal(expected['refunds'])
assert sum(Decimal(d['net']) for d in r['sales'])==Decimal(expected['gross'])-Decimal(expected['refunds'])
for product in r['products']:
    value=json.loads(pg(f"SELECT json_build_object('units',sum(i.quantity),'revenue',sum(i.line_total-i.discount_amount)::text) FROM orders.order_items i JOIN orders.orders o ON o.id=i.order_id LEFT JOIN payments.manual_refunds r ON r.order_id=o.id WHERE i.product_id='{uuid.UUID(product['product_id'])}' AND o.status NOT IN ('cancelled','delivery_failed') AND r.id IS NULL AND (o.created_at AT TIME ZONE 'UTC')::date BETWEEN '{start}' AND '{end}';"))
    assert product['units']==value['units']
    assert Decimal(product['revenue'])==Decimal(value['revenue'])
seeded=report(today-dt.timedelta(days=60),today-dt.timedelta(days=1))
assert seeded['funnel']=={'visitors':10000,'carts':5000,'checkouts':2500,'purchases':1250},seeded['funnel']
assert sum(t['sessions'] for t in seeded['traffic'])==10000
for row in r['cohorts']:
    expected_cohort=json.loads(pg(f"WITH valid AS (SELECT o.customer_id,(o.created_at AT TIME ZONE 'UTC')::date AS day,coalesce(r.amount,0) refunded FROM orders.orders o LEFT JOIN payments.manual_refunds r ON r.order_id=o.id WHERE o.status NOT IN ('cancelled','delivery_failed')), cohorts AS (SELECT customer_id,date_trunc('month',min(day))::date cohort FROM valid GROUP BY customer_id) SELECT json_build_object('customers',count(DISTINCT c.customer_id),'returning',count(DISTINCT v.customer_id) FILTER(WHERE date_trunc('month',v.day)=c.cohort+interval '{int(row['month'])} months' AND v.refunded=0)) FROM cohorts c JOIN valid v ON v.customer_id=c.customer_id WHERE c.cohort='{dt.date.fromisoformat(row['cohort'])}';"))
    assert row['customers']==expected_cohort['customers'],(row,expected_cohort)
    assert row['returning']==expected_cohort['returning'],(row,expected_cohort)
for row in r['ltv']:
    value=json.loads(pg(f"WITH buyers AS (SELECT o.customer_id,min((o.created_at AT TIME ZONE 'UTC')::date) first_order,sum(o.total-coalesce(r.amount,0)) value FROM orders.orders o LEFT JOIN payments.manual_refunds r ON r.order_id=o.id WHERE o.status NOT IN ('cancelled','delivery_failed') GROUP BY o.customer_id) SELECT json_build_object('customers',count(*),'value',sum(value)::text) FROM buyers WHERE first_order BETWEEN '{start}' AND '{end}';"))
    assert row['customers']==value['customers']
    assert Decimal(row['value'])==Decimal(value['value'])
latencies=[]
for _ in range(5):
    began=time.perf_counter();report();latencies.append(time.perf_counter()-began)
assert max(latencies)<2,latencies
# Same identifier is accepted repeatedly but counted once, even before merges.
event_id=str(uuid.uuid4());session=str(uuid.uuid4());event(event_id,session);event(event_id,session)
assert int(ch(f"SELECT count() FROM browser_events FINAL WHERE id='{event_id}'"))==1
# Browser ingestion must not update PostgreSQL rate limit counters.
rate_before=pg("SELECT coalesce(sum(attempts),0) FROM platform.rate_limits WHERE key LIKE 'http:analytics:%';")
load_session=str(uuid.uuid4())
before=int(ch(f"SELECT count() FROM browser_events FINAL WHERE session_id='{load_session}'"))
product=pg("SELECT id FROM catalog.products WHERE active ORDER BY id LIMIT 1;")
assert product
commerce_latencies=[];commerce_errors=[];stop=threading.Event()
def commerce_probe():
    while not stop.is_set():
        began=time.perf_counter()
        try:get(a.gateway+'/v1/catalog/products/'+product)
        except Exception as error:commerce_errors.append(str(error))
        commerce_latencies.append(time.perf_counter()-began)
        stop.wait(.1)
monitor=threading.Thread(target=commerce_probe)
monitor.start()
start_load=time.perf_counter()
try:
    with futures.ThreadPoolExecutor(max_workers=32) as executor:
        timings=list(executor.map(lambda _:event(session=load_session),range(a.events)))
finally:
    stop.set();monitor.join()
elapsed=time.perf_counter()-start_load
assert not commerce_errors,commerce_errors
assert commerce_latencies and max(commerce_latencies)<2,commerce_latencies
after=int(ch(f"SELECT count() FROM browser_events FINAL WHERE session_id='{load_session}'"))
assert after-before==a.events,(after,before)
assert pg("SELECT coalesce(sum(attempts),0) FROM platform.rate_limits WHERE key LIKE 'http:analytics:%';")==rate_before
p95=sorted(timings)[int(len(timings)*.95)]
assert p95<2,p95
metrics=get(a.gateway+'/metrics').decode()
assert 'commerce_http_requests_total' in metrics and 'commerce_reporting_last_success_seconds' in metrics
results={'accuracy':'sales/products/cohorts/LTV match PostgreSQL','funnel':seeded['funnel'],'report_max_seconds':round(max(latencies),3),'accepted_events':a.events,'events_per_second':round(a.events/elapsed,1),'ingest_p95_seconds':round(p95,3),'postgres_analytics_rate_writes':0,'duplicate_events':1,'concurrent_product_reads':len(commerce_latencies),'product_read_max_seconds':round(max(commerce_latencies),3)}
if a.observability:
    product=pg("SELECT id FROM catalog.products WHERE active ORDER BY id LIMIT 1;")
    assert product
    trace_id=uuid.uuid4().hex;parent=uuid.uuid4().hex[:16]
    req=urllib.request.Request(a.gateway+'/v1/admin/reports/trace-probe',headers={'traceparent':f'00-{trace_id}-{parent}-01','Cookie':'admin_session='+token})
    probe_start=time.perf_counter()
    with urllib.request.urlopen(req,timeout=20) as response:
        assert response.headers['x-trace-id']==trace_id
    assert time.perf_counter()-probe_start>=.25
    deadline=time.monotonic()+40
    trace=None
    while time.monotonic()<deadline:
        try:
            request=urllib.request.Request('http://localhost:3200/api/traces/'+trace_id,headers={'Accept':'application/json'})
            with urllib.request.urlopen(request,timeout=5) as response:trace=json.load(response)
            names=[s['name'] for batch in trace.get('batches',trace.get('resourceSpans',[])) for scope in batch.get('scopeSpans',batch.get('instrumentationLibrarySpans',[])) for s in scope.get('spans',[])]
            if {'http.request','diagnostics.database','db.query'}<=set(names):break
        except (urllib.error.URLError,ValueError):pass
        time.sleep(1)
    else:raise AssertionError(('Trace unavailable',trace))
    results['trace_id']=trace_id;results['trace_spans']=names
    query=urllib.parse.urlencode({'query':f'{{service="commerce-gateway"}} |= "{trace_id}"','limit':10})
    logs=json.loads(get('http://localhost:3100/loki/api/v1/query_range?'+query))
    assert logs['data']['result'],logs
print(json.dumps(results,indent=2))
