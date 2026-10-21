"""Loopback-only synthetic M08 admin UI fixture; never connects to commerce or a model.
Run with python3; start admin Vite with API_PROXY_TARGET=http://127.0.0.1:18088.
"""
import json
from datetime import datetime, timezone
from urllib.parse import urlparse, parse_qs
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ID = "00000000-0000-0000-0000-000000000008"
HISTORY=[]
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def reply(self, value, status=200):
        body=json.dumps(value).encode()
        self.send_response(status); self.send_header("Content-Type","application/json"); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        if self.path.split('?')[0] == '/v1/admin/me':
            self.reply({"user":{"id":ID,"email":"m08@example.test","name":"Fixture Merchant","role_id":ID,"active":True,"created_at":"2026-09-15T00:00:00Z"},"permissions":["reports.read","orders.read","inventory.read","catalog.read"]})
        elif self.path.split('?')[0]=='/v1/admin/assistant/history':
            cid=parse_qs(urlparse(self.path).query).get('conversation_id',[None])[0]
            self.reply([row for row in reversed(HISTORY) if cid is None or row['conversation_id']==cid])
        elif self.path.split('?')[0]=='/v1/admin/assistant/metrics':
            self.reply({'turns':len(HISTORY),'conversations':len(set(r['conversation_id'] for r in HISTORY)),'helpful':sum(r['helpful'] is True for r in HISTORY),'not_helpful':sum(r['helpful'] is False for r in HISTORY),'latency_ms':12})
        else: self.reply({"error":"Fixture endpoint unavailable"},503)
    def do_POST(self):
        if self.path=='/v1/admin/assistant/feedback':
            data=json.loads(self.rfile.read(int(self.headers.get('Content-Length',0))))
            for row in HISTORY:
                if row['request_id']==data['request_id']: row['helpful']=data['helpful']
            self.reply({'status':'ok'}); return
        if self.path!='/v1/admin/assistant/query': self.reply({},404); return
        size=int(self.headers.get('Content-Length',0))
        if size>4096: self.reply({},413); return
        data=json.loads(self.rfile.read(size))
        if data['currency']=='EUR': self.reply({"error":"Fixture permission denied"},403); return
        modes={
            'orders':('Orders by current status',['Status','Orders','Order value','Recorded refunds','Value less refunds'],[['cash_collected','3','120.00','10.00','110.00'],['cancelled','1','40.00','0','40.00']]),
            'low_stock':('Low-stock products',['Product ID','Product','SKU','On hand','Reserved','Available'],[[ID,'Running shoes','SHOE-42','8','5','3']]),
            'top_sellers':('Top sellers by ordered units',['Product ID','Product at order time','Units','Merchandise value'],[[ID,'Running shoes','12','1080.00']]),
            'slow_stock':('High stock with low ordered units',['Product ID','Product','Available','Ordered units'],[[ID,'Trail shoes','80','0']]),
            'category_decline':('Categories with declining merchandise value',['Category ID','Current category','Previous value','Current value','Change'],[[ID,'Shoes','100.00','40.00','-60.00']]),
            'order_status':('Current order status',['Order ID','Order number','Status','Created UTC','Order value','Recorded refunds'],[[data.get('order_id') or ID,'108','shipped','2026-09-15 00:00:00','99.00','0']]),
        }
        title,columns,rows=modes[data['question']]
        answer={**{k:data[k] for k in ['question','from','to','currency','scope']},'title':title,'columns':columns,'rows':rows,'evaluated_at':datetime.now(timezone.utc).isoformat(),'notes':['Source: synthetic browser fixture. Production queries use authoritative commerce records.','Scope: installation; no store/channel breakdown.','Cancelled and failed orders are excluded from product sales. Refunds cannot be allocated to items.'],'truncated':False,'request_id':data['request_id'],'conversation_id':data['conversation_id'],'helpful':None}
        HISTORY.append(answer)
        self.reply(answer)
if __name__=='__main__':
    print('Synthetic merchant fixture: http://127.0.0.1:18088',flush=True)
    ThreadingHTTPServer(('127.0.0.1',18088),Handler).serve_forever()
