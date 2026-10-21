"""Local alert sink: logs Alertmanager notifications; never sends external messages."""
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length=int(self.headers.get('Content-Length','0'))
        if length>65536:
            self.send_error(413)
            return
        try:
            alert=json.loads(self.rfile.read(length))
            print(json.dumps({'service':'local-alert-receiver','status':alert.get('status'),'alerts':[{'labels':a.get('labels'),'status':a.get('status')} for a in alert.get('alerts',[])]}),flush=True)
        except (ValueError,TypeError):
            self.send_error(400)
            return
        self.send_response(200)
        self.end_headers()
HTTPServer(('0.0.0.0',9094),Handler).serve_forever()
