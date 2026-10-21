"""Synthetic operator tracking fixture. No production data or service calls."""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
ID = '00000000-0000-0000-0000-000000000001'
REPORT = json.loads((ROOT / 'output/intent-debug/example.json').read_text())
REPORT.pop('capture_origin', None)
REPORT.update(request_id=ID, redacted=True)
REPORT['events'].insert(0, {'stage':'fixture_notice', 'data':'Synthetic preview: mocked retrieval/model responses.'})
REPORT['events'].append({'stage':'provider_wire_payload','data':{'model':'fixture-model','input':[{'role':'user','content':'Let me peek at my basket'}],'instructions':'Interpret shopper intent and return a structured proposal.','max_output_tokens':2048,'store':False,'stream':False}})

class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def reply(self,body,status=200):
        data=json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type','application/json')
        self.send_header('Cache-Control','no-store')
        self.end_headers()
        self.wfile.write(data)
    def do_GET(self):
        url=urlparse(self.path)
        if url.path=='/v1/admin/me':
            return self.reply({'user':{'id':ID,'name':'Tracking preview operator','email':'preview@example.test','active':True,'role_id':ID},'permissions':['assistant.tracking.read','assistant.tracking.export']})
        if url.path=='/v1/admin/assistant/tracking':
            query=parse_qs(url.query)
            items=[] if query.get('outcome')==['unavailable'] else [{'request_id':ID,'created_at':'2026-10-03T12:00:00Z','outcome':'completed','latency_ms':230,'conversation_id':ID,'route':'cart_read','intent':'VIEW_CART','model':'fixture-model','model_calls':1,'input_tokens':410,'output_tokens':25,'question_preview':'Let me peek at my basket','report_available':True}]
            return self.reply({'capture_enabled':True,'retention_days':7,'items':items,'next_cursor':None})
        if url.path in [f'/v1/admin/assistant/tracking/{ID}',f'/v1/admin/assistant/tracking/{ID}/export']:
            return self.reply(REPORT)
        return self.reply({'error':'Report was not captured or has expired.'},404)

if __name__=='__main__':
    print('Tracking fixture at http://127.0.0.1:18089',flush=True)
    ThreadingHTTPServer(('127.0.0.1',18089),Handler).serve_forever()
