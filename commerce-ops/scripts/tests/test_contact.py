import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('contact', Path(__file__).resolve().parents[3] / 'commerce-ops/deploy/contact/server.py')
contact = importlib.util.module_from_spec(spec)
spec.loader.exec_module(contact)


class ContactTests(unittest.TestCase):
    def data(self):
        return dict(name='Example Visitor', email='visitor@example.com', company='Example', topic='Sales', message='Please arrange a product demo.', website='')

    def test_fixed_recipient_and_reply_to(self):
        data = self.data()
        data['to'] = 'attacker@example.com'
        mail = contact.message_from(data)
        self.assertEqual(mail['To'], 'info@rocento.com')
        self.assertEqual(mail['From'], 'info@rocento.com')
        self.assertEqual(mail['Reply-To'], 'visitor@example.com')
        self.assertIn(data['message'], mail.get_content())

    def test_rejects_invalid_or_injected_fields(self):
        for field, value in [('email', 'visitor@example.com\r\nBcc: attacker@example.com'), ('website', 'spam'), ('topic', 'arbitrary'), ('message', 'short'), ('name', ''), ('message', 'x'*5001), ('email', ['invalid'])]:
            with self.subTest(field=field, value=value):
                data = self.data()
                data[field] = value
                with self.assertRaises(ValueError):
                    contact.message_from(data)
