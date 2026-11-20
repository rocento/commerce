import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[3]
spec=importlib.util.spec_from_file_location('alerts',ROOT/'commerce-ops/services/onboarding/provisioning-alerts.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)

class AlertTests(unittest.TestCase):
    def test_failed_replacement_preserves_prior_delivery_ledger(self):
        with tempfile.TemporaryDirectory() as root:
            path=Path(root)/'deliveries.json'
            prior={'job:fixture':{'status':'in-flight'}}
            path.write_text(json.dumps(prior))
            with patch.object(m.os,'replace',side_effect=OSError('interrupted replacement')):
                with self.assertRaises(OSError):m.write_state(path,{'new':'value'})
            self.assertEqual(json.loads(path.read_text()),prior)
            self.assertEqual(list(Path(root).iterdir()),[path])

    def test_state_replacement_is_private_and_complete(self):
        with tempfile.TemporaryDirectory() as root:
            path=Path(root)/'deliveries.json'
            value={'job:fixture':{'status':'accepted-by-smtp'}}
            m.write_state(path,value)
            self.assertEqual(json.loads(path.read_text()),value)
            self.assertEqual(path.stat().st_mode&0o777,0o600)

    def test_authorized_test_is_sent_once(self):
        with tempfile.TemporaryDirectory() as root:
            config=Path(root)/'config';config.mkdir()
            (config/'alerts.json').write_text(json.dumps({'recipient':'operator@example.test'}))
            (config/'smtp.json').write_text('{}')
            with patch.object(m,'CONFIG',config),patch.object(m,'STATE',Path(root)/'state'),patch.object(m.sys,'argv',['alerts','--test']),patch.object(m,'send',return_value='<fixture>') as send:
                m.main();m.main()
                send.assert_called_once()

    def test_ambiguous_delivery_is_not_repeated(self):
        with tempfile.TemporaryDirectory() as root:
            config=Path(root)/'config';config.mkdir()
            (config/'alerts.json').write_text(json.dumps({'recipient':'operator@example.test'}))
            (config/'smtp.json').write_text('{}')
            with patch.object(m,'CONFIG',config),patch.object(m,'STATE',Path(root)/'state'),patch.object(m.sys,'argv',['alerts','--test']),patch.object(m,'send',side_effect=TimeoutError) as send:
                with self.assertRaises(TimeoutError):m.main()
                m.main();send.assert_called_once()

    def test_recipient_header_injection_is_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            (Path(root)/'alerts.json').write_text(json.dumps({'recipient':'operator@example.test\nBcc:other@example.test'}))
            with patch.object(m,'CONFIG',Path(root)),patch.object(m,'send') as send:
                with self.assertRaises(ValueError):m.main()
                send.assert_not_called()

if __name__=='__main__':unittest.main()
