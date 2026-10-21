"""Loopback-only contact form endpoint; mail is sent only to Rocento."""
from collections import deque
from email.message import EmailMessage
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
import re
import smtplib
import ssl
import time

RECIPIENT = 'info@rocento.com'
attempts = deque()


def parse_form(payload):
    # The public form is flat. Bound nesting before entering the JSON decoder:
    # deeply nested, size-valid input can exhaust the native decoder's stack.
    text = payload.decode('utf-8')
    depth = 0
    quoted = False
    escaped = False
    for char in text:
        if quoted:
            if escaped:
                escaped = False
            elif char == '\\':
                escaped = True
            elif char == '"':
                quoted = False
        elif char == '"':
            quoted = True
        elif char in '[{':
            depth += 1
            if depth > 16:
                raise ValueError('Invalid form')
        elif char in ']}':
            depth -= 1
    return json.loads(text)


def message_from(data):
    if not isinstance(data, dict):
        raise ValueError('Invalid form')
    fields = {}
    for name, limit in [('name', 100), ('email', 254), ('company', 150), ('topic', 30), ('message', 5000), ('website', 200)]:
        value = data.get(name, '')
        if not isinstance(value, str) or len(value) > limit:
            raise ValueError('Invalid field')
        fields[name] = value.strip()
    if fields['website']:
        raise ValueError('Invalid form')
    if not fields['name'] or len(fields['message']) < 10:
        raise ValueError('Name and message required')
    if not re.fullmatch(r'[A-Za-z0-9.!#$%&\x27*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+', fields['email']):
        raise ValueError('Invalid email')
    if fields['topic'] not in ('Sales', 'Support', 'Demo request', 'Partnership'):
        raise ValueError('Invalid topic')
    mail = EmailMessage()
    mail['From'] = RECIPIENT
    mail['To'] = RECIPIENT
    mail['Reply-To'] = fields['email']
    mail['Subject'] = 'Rocento website — ' + fields['topic']
    mail.set_content('\n'.join([f"Name: {fields['name']}", f"Email: {fields['email']}", f"Company: {fields['company']}", '', fields['message']]))
    return mail


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def log_message(self, *args):
        pass  # Do not put form content or personal information in logs.

    def reply(self, status):
        body = json.dumps({'ok': status == 200}).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path != '/api/contact':
            return self.reply(404)
        if self.headers.get('Origin') != os.getenv('CONTACT_ORIGIN', 'https://rocento.com'):
            return self.reply(403)
        if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
            return self.reply(415)
        now = time.monotonic()
        while attempts and now - attempts[0] > 3600:
            attempts.popleft()
        if len(attempts) >= 30:
            return self.reply(429)
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 32768:
                return self.reply(413)
            mail = message_from(parse_form(self.rfile.read(size)))
        except (ValueError, UnicodeError, RecursionError):
            return self.reply(400)
        password = os.getenv('CONTACT_SMTP_PASSWORD', '')
        if not password:
            return self.reply(503)
        attempts.append(now)
        try:
            with smtplib.SMTP_SSL(os.getenv('CONTACT_SMTP_HOST', 'mail.privateemail.com'), 465,
                                  timeout=15, context=ssl.create_default_context()) as smtp:
                smtp.login(RECIPIENT, password)
                smtp.send_message(mail, from_addr=RECIPIENT, to_addrs=[RECIPIENT])
        except (OSError, smtplib.SMTPException):
            print('Contact SMTP delivery failed; verify server credentials and connectivity.', flush=True)
            return self.reply(502)
        return self.reply(200)


if __name__ == '__main__':
    HTTPServer(('127.0.0.1', 8095), Handler).serve_forever()
