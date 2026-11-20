"""Guard the exact capacity migration already applied to the three EC2 stores."""
import hashlib
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[3]


class CapacityMigrationHistoryTests(unittest.TestCase):
    def test_deployed_capacity_migration_is_immutable(self):
        source = ROOT / 'commerce-api/rocento-api/migrations/20260922120000_fulfillment_capacity.sql'
        self.assertEqual(
            hashlib.sha384(source.read_bytes()).hexdigest(),
            '335a9dcda5a2635f22d46d13ee0b27d1b635e2168ce9aeedce86180d66393c97539acf249cf486bf37c50ab7c924b223',
            'Already deployed: put new capacity changes in a later migration.',
        )


if __name__ == '__main__':
    unittest.main()
