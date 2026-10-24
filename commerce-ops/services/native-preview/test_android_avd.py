import json
from pathlib import Path
import tempfile
import unittest
from android_avd import create_avd, digest, system_ui_ready, validate_seed


class SeedTests(unittest.TestCase):
    def test_system_ui_must_finish_its_own_service_start(self):
        ready = '\n  * ServiceRecord{x u0 com.android.systemui/.SystemUIService c:android}\n app=ProcessRecord{x}\n startCommandResult=1\n'
        self.assertTrue(system_ui_ready(ready))
        self.assertFalse(system_ui_ready(ready + ' executeNesting=1 executingStart=-10s\n'))
        self.assertFalse(system_ui_ready(ready.replace('startCommandResult=1', 'startCommandResult=0')))
        self.assertFalse(system_ui_ready(ready.replace('app=ProcessRecord{x}', 'app=null')))
        self.assertFalse(system_ui_ready(ready.replace('.SystemUIService', '.keyguard.KeyguardService')))
        self.assertFalse(system_ui_ready('ACTIVITY MANAGER SERVICES\n(no services)'))

    def test_seed_checks_os_geometry_content_and_no_apps(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            image = root / 'x86_64'; image.mkdir()
            (image / 'system.img').write_bytes(b'os')
            (root / 'userdata.img').write_bytes(b'clean userdata')
            (root / 'encryptionkey.img').write_bytes(b'clean os encryption metadata')
            data = {'format': 1, 'geometry': [540, 1200, 210, 2048],
                    'systemSha256': digest(image / 'system.img'), 'seedSha256': digest(root / 'userdata.img'),
                    'encryptionKeySha256': digest(root / 'encryptionkey.img'), 'thirdPartyPackages': []}
            manifest = root / 'manifest.json'
            manifest.write_text(json.dumps(data))
            self.assertEqual(validate_seed(manifest, image), root / 'userdata.img')
            for key, value in [('thirdPartyPackages', ['package:com.example']), ('systemSha256', 'wrong'),
                               ('seedSha256', 'wrong'), ('encryptionKeySha256', 'wrong'), ('geometry', [1080, 2400, 420, 2048])]:
                manifest.write_text(json.dumps(dict(data, **{key: value})))
                with self.subTest(key=key), self.assertRaises(ValueError): validate_seed(manifest, image)

    def test_seed_and_sessions_use_same_geometry(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp).resolve()
            avd = create_avd(root, root / 'x86_64')
            config = (avd / 'config.ini').read_text()
            for value in ['hw.lcd.width=432', 'hw.lcd.height=960', 'hw.ramSize=2048', 'hw.cpu.arch=x86_64']:
                self.assertIn(value, config)
