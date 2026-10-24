import datetime as dt
import importlib.util
import http.client
from pathlib import Path
import threading
import time
import unittest
from unittest.mock import Mock

spec = importlib.util.spec_from_file_location('worker', Path(__file__).with_name('worker.py'))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
SID = '11111111-1111-4111-8111-111111111111'
MERCHANT = '22222222-2222-4222-8222-222222222222'


class SecurityTests(unittest.TestCase):
    def payload(self):
        return dict(merchantId=MERCHANT, environment='production', code=SID + '.' + 'a'*64,
                    expiresAt=(dt.datetime.now(dt.timezone.utc) + dt.timedelta(minutes=30)).isoformat())

    def test_allowlist_tenant_environment_and_capability(self):
        artifacts = {MERCHANT + ':production': {'app': '/trusted/app'}}
        self.assertEqual(worker.validate_request(SID, self.payload(), artifacts)[0], artifacts[MERCHANT + ':production'])
        for key, value in [('merchantId', SID), ('environment', 'staging'), ('code', SID + '.bad'), ('expiresAt', '2000-01-01T00:00:00Z')]:
            data = self.payload(); data[key] = value
            with self.assertRaises(ValueError):
                worker.validate_request(SID, data, artifacts)
        data = self.payload(); data['app'] = '/client/executable'
        with self.assertRaises(ValueError):
            worker.validate_request(SID, data, artifacts)

    def test_no_stale_frames_after_expiry_failure_or_stop(self):
        host = worker.Worker.__new__(worker.Worker)
        host.lock = threading.RLock()
        state = dict(expiry=time.time()+60, lease=0, stop=threading.Event(), frame=b'png', captured=time.monotonic(), failed=False)
        host.sessions = {SID: state}
        self.assertEqual(host.get(SID), (200, b'png'))
        self.assertGreater(state['lease'], time.monotonic())
        self.assertEqual(host.get(MERCHANT)[0], 404)
        state['captured'] -= 20
        self.assertEqual(host.get(SID)[0], 503)
        state['failed'] = True
        self.assertEqual(host.get(SID)[0], 503)
        state['stop'].set()
        self.assertEqual(host.get(SID)[0], 404)

        state['stop'].clear(); state['expiry'] = 0
        self.assertEqual(host.get(SID)[0], 404)

    def test_framework_allowlist_and_shared_capacity(self):
        native, rn = {'app': '/native'}, {'app': '/react-native'}
        artifacts = {MERCHANT + ':production': native, MERCHANT + ':production:react-native': rn}
        data = self.payload()
        self.assertEqual(worker.validate_request(SID, data, artifacts)[0], native)
        data['implementation'] = 'react-native'
        self.assertEqual(worker.validate_request(SID, data, artifacts)[0], rn)
        with self.assertRaises(ValueError):
            worker.validate_request(SID, data, {MERCHANT + ':production': native})
        host = worker.Worker.__new__(worker.Worker)
        host.lock = threading.RLock(); host.args = Mock(capacity=1)
        host.artifacts = artifacts; host.sessions = {MERCHANT: {}}
        self.assertFalse(host.start(SID, data))
        data['implementation'] = 'native'
        self.assertFalse(host.start(SID, data))
        data['implementation'] = '../native'
        with self.assertRaises(ValueError):
            worker.validate_request(SID, data, artifacts)

    def test_capacity_does_not_start_simulator(self):
        host = worker.Worker.__new__(worker.Worker)
        host.lock = threading.RLock(); host.args = Mock(capacity=1)
        host.artifacts = {MERCHANT + ':production': {}}
        host.sessions = {MERCHANT: {}}
        self.assertFalse(host.start(SID, self.payload()))


class WorkerHTTPTests(unittest.TestCase):
    def test_bearer_required_before_frame_or_commands(self):
        server = worker.ThreadingHTTPServer(('127.0.0.1', 0), worker.Handler)
        server.token = 'a' * 64
        server.worker = Mock()
        server.worker.get.return_value = (202, b'')
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            for auth, expected in [('', 401), ('Bearer wrong', 401), ('Bearer ' + server.token, 202)]:
                connection = http.client.HTTPConnection(*server.server_address, timeout=3)
                connection.request('GET', '/sessions/' + SID, headers={'Authorization': auth})
                response = connection.getresponse()
                self.assertEqual(response.status, expected)
                self.assertEqual(response.getheader('Cache-Control'), 'private, no-store')
                response.read(); connection.close()
            server.worker.get.assert_called_once_with(SID)
            server.worker.start.return_value = False
            connection = http.client.HTTPConnection(*server.server_address, timeout=3)
            connection.request('POST', '/sessions/' + SID, body='{}', headers={'Authorization': 'Bearer ' + server.token})
            response = connection.getresponse()
            self.assertEqual(response.status, 409)
            response.read(); connection.close()

            connection = http.client.HTTPConnection(*server.server_address, timeout=3)
            server.worker.start.side_effect = ValueError('invalid')
            connection.request('POST', '/sessions/' + SID, body='[]', headers={'Authorization': 'Bearer ' + server.token})
            response = connection.getresponse()
            self.assertEqual(response.status, 400)
            response.read(); connection.close()
        finally:
            server.shutdown(); server.server_close(); thread.join()


if __name__ == '__main__':
    unittest.main()
