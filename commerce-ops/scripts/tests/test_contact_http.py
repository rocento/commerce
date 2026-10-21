"""Exercise the contact handler over real HTTP without contacting an email provider."""
import http.client
import importlib.util
import json
import os
from pathlib import Path
import threading
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    'contact_http_fixture', Path(__file__).resolve().parents[3] / 'commerce-ops/deploy/contact/server.py')
contact = importlib.util.module_from_spec(spec)
spec.loader.exec_module(contact)


class ContactHttpTests(unittest.TestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ, {
            'CONTACT_ORIGIN': 'https://example.test', 'CONTACT_SMTP_PASSWORD': ''})
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.server = contact.HTTPServer(('127.0.0.1', 0), contact.Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.close_server)

    def close_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def request(self, body, **headers):
        connection = http.client.HTTPConnection('127.0.0.1', self.server.server_port, timeout=5)
        try:
            connection.request('POST', '/api/contact', body, {
                'Origin': 'https://example.test', 'Content-Type': 'application/json', **headers})
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_deeply_nested_json_is_rejected_and_next_request_works(self):
        self.assertEqual(self.request(b'[' * 12000 + b'0' + b']' * 12000), (400, {'ok': False}))
        self.assertEqual(self.request(b'{}'), (400, {'ok': False}))

    def test_invalid_payloads_and_ingress_boundaries(self):
        for body in (b'{', b'null', b'[]', b'"text"', b'\xff', b'{}'):
            with self.subTest(body=body):
                self.assertEqual(self.request(body), (400, {'ok': False}))
        self.assertEqual(self.request(b'{}', Origin='https://attacker.test'), (403, {'ok': False}))
        self.assertEqual(self.request(b'{}', **{'Content-Type': 'text/plain'}), (415, {'ok': False}))
        self.assertEqual(self.request(b'x' * 32769), (413, {'ok': False}))

    def test_missing_smtp_is_unavailable_without_accepting_delivery(self):
        body = json.dumps({'name': 'QA', 'email': 'qa@example.test', 'topic': 'Support',
                           'message': 'Synthetic local contact request.'}).encode()
        self.assertEqual(self.request(body), (503, {'ok': False}))

    def test_quoted_brackets_and_escaped_quotes_are_not_json_nesting(self):
        body = json.dumps({'name': 'QA', 'email': 'qa@example.test', 'topic': 'Support',
                           'message': 'Text with \\" and ' + '[' * 2000}).encode()
        self.assertEqual(self.request(body), (503, {'ok': False}))
