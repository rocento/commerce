import importlib.util
import os
import subprocess
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch, Mock

spec = importlib.util.spec_from_file_location('cleanup', Path(__file__).resolve().parents[3] / 'commerce-ops/deploy/ec2/server/cleanup.py')
cleanup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cleanup)


class CleanupTests(unittest.TestCase):
    def test_development_cleanup_preserves_source_and_symlink_targets(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / 'checkout'
            root.mkdir()
            cache = root / '.mypy_cache'
            cache.mkdir()
            (cache / 'cached').write_text('disposable')
            package_cache = root / '.pnpm-store'
            package_cache.mkdir()
            next_cache = root / 'commerce-corporate-site/.next'
            next_cache.mkdir(parents=True)
            (next_cache / 'cache').write_text('disposable')
            source = root / 'app.py'
            source.write_text('source')
            outside = Path(folder) / 'outside'
            outside.mkdir()
            (outside / 'keep').write_text('keep')
            (root / '.pytest_cache').symlink_to(outside)
            (root / 'commerce-assistant-platform').symlink_to(outside)
            (outside / '.mypy_cache').mkdir()
            metadata = root / 'commerce-corporate-site/tsconfig.tsbuildinfo'
            metadata.parent.mkdir(parents=True, exist_ok=True)
            metadata.write_text('cache')
            cleanup.clean_development_caches(root)
            self.assertFalse(cache.exists())
            self.assertFalse(package_cache.exists())
            self.assertFalse(next_cache.exists())
            self.assertEqual(source.read_text(), 'source')
            self.assertTrue((outside / 'keep').exists())
            self.assertTrue((outside / '.mypy_cache').is_dir())
            self.assertTrue((root / '.pytest_cache').is_symlink())
            self.assertFalse(metadata.exists())

    def test_package_cleanup_only_when_low(self):
        for free, expected in ((29800, 1), (30100, 0)):
            with self.subTest(free=free), patch.object(cleanup.shutil, 'disk_usage', return_value=Mock(free=free*1024*1024)), patch.object(cleanup.shutil, 'which', return_value='/usr/bin/apt-get'), patch.object(cleanup.subprocess, 'run') as run:
                cleanup.clean_package_cache(Path('/opt/rocento'))
                self.assertEqual(run.call_count, expected)
                if expected:
                    self.assertEqual(run.call_args.args[0], ['apt-get', 'clean'])

    def test_cache_fallback_only_when_still_low(self):
        for levels, expected in (([28000, 28000], 2), ([28000, 31000], 1), ([31000], 0)):
            with self.subTest(levels=levels), patch.object(cleanup.shutil, 'disk_usage', side_effect=[Mock(free=n*1024*1024) for n in levels]), patch.object(cleanup.shutil, 'which', return_value='/usr/bin/docker'), patch.object(cleanup.subprocess, 'run') as run:
                cleanup.clean_build_cache(Path('/opt/rocento'))
                self.assertEqual(run.call_count, expected)
                if expected == 2:
                    self.assertEqual(run.call_args.args[0], ['docker', 'builder', 'prune', '--force', '--all'])

    def test_dangling_images_only_when_low_and_preserves_tagged_and_recent_images(self):
        for free, expected in ((29900, 1), (30000, 0)):
            with self.subTest(free=free), patch.object(cleanup.shutil, 'disk_usage', return_value=Mock(free=free*1024*1024)), patch.object(cleanup.shutil, 'which', return_value='/usr/bin/docker'), patch.object(cleanup.subprocess, 'run') as run:
                cleanup.clean_dangling_images(Path('/opt/rocento'))
                self.assertEqual(run.call_count, expected)
                if expected:
                    self.assertEqual(run.call_args.args[0], ['docker', 'image', 'prune', '--force', '--filter', 'until=24h'])

    def test_dangling_cleanup_failure_leaves_preflight_to_enforce_disk_reserve(self):
        with patch.object(cleanup.shutil, 'disk_usage', return_value=Mock(free=29900*1024*1024)), patch.object(cleanup.shutil, 'which', return_value='/usr/bin/docker'), patch.object(cleanup.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, 'docker')):
            cleanup.clean_dangling_images(Path('/opt/rocento'))

    def test_keeps_active_rollbacks_and_unmanaged_files(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            releases = base / 'releases'
            releases.mkdir()
            paths = []
            for i in range(5):
                path = releases / f'release-{i:08d}'
                path.mkdir()
                os.utime(path, (i + 1, i + 1))
                paths.append(path)
            (base / 'current').symlink_to(paths[0])
            other = releases / 'uploads'
            other.mkdir()
            link = releases / 'release-aaaaaaaa'
            link.symlink_to(other)
            cleanup.clean_releases(base)
            self.assertEqual([p.exists() for p in paths], [True, False, False, True, True])
            self.assertTrue(other.is_dir())
            self.assertTrue(link.is_symlink())

    def test_named_complete_frontend_releases_share_rollback_retention(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            releases = base / 'releases'
            releases.mkdir()
            paths = []
            for i, name in enumerate(('legacy-old', 'docs-20261004', 'card-details-old', 'admin-current', 'card-details-active')):
                path = releases / name
                for site in ('website', 'storefront', 'grocery-admin'):
                    (path / site).mkdir(parents=True)
                    (path / site / 'index.html').write_text('built asset')
                os.utime(path, (i + 1, i + 1))
                paths.append(path)
            (base / 'current').symlink_to(paths[-1])
            unknown = releases / 'customer-data'
            unknown.mkdir()
            (unknown / 'keep').write_text('persistent')
            cleanup.clean_releases(base)
            self.assertEqual([p.exists() for p in paths], [False, False, True, True, True])
            self.assertEqual((unknown / 'keep').read_text(), 'persistent')

    def test_without_active_pointer_deletes_nothing(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            release = base / 'releases/release-00000000'
            release.mkdir(parents=True)
            cleanup.clean_releases(base)
            self.assertTrue(release.exists())
