"""Exercise launcher retries/seed routing with fake transports; never deploy."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[3]


def rsync_transfers(calls):
    return [call for call in calls if call[0] == 'rsync' and '--version' not in call]


class DeployTransportTests(unittest.TestCase):
    def test_preserve_ai_excludes_unvalidated_local_ai_and_marks_staged_mode(self):
        result, calls = self.run_launcher(0, 0, fail_release=True, args=('--preserve-ai',))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(any(c[0] == 'node' for c in calls))
        upload = rsync_transfers(calls)[0]
        for option in ('--exclude=/commerce-assistant-platform/', '--exclude=/commerce-ops/deploy/assistant/', '--exclude=/commerce-ops/compose/compose.language-engine.yaml'):
            self.assertIn(option, upload)
        self.assertLess(upload.index('--exclude=/commerce-assistant-platform/'), upload.index('--include=/commerce-assistant-platform/'))
        self.assertTrue(any(c[0] == 'ssh' and '/preserve-ai' in c[-1] for c in calls))

    def test_plain_command_includes_ai_and_validates_release(self):
        result, calls = self.run_launcher(0, 0)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(any(c[0] == 'node' and c[-1].endswith('check-release.ts') for c in calls))
        self.assertNotIn('--exclude=/commerce-assistant-platform/', rsync_transfers(calls)[0])
        self.assertFalse(any(c[0] == 'ssh' and '/preserve-ai' in c[-1] for c in calls))

    def test_explicit_ai_deploy_validates_and_includes_ai(self):
        result, calls = self.run_launcher(0, 0, args=('--include-ai',))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(any(c[0] == 'node' and c[-1].endswith('check-release.ts') for c in calls))
        self.assertNotIn('--exclude=/commerce-assistant-platform/', rsync_transfers(calls)[0])
        self.assertFalse(any(c[0] == 'ssh' and '/preserve-ai' in c[-1] for c in calls))

    def test_language_export_requires_explicit_release_and_rejects_preservation(self):
        for args in (('--sync-language-db',), ('--preserve-ai', '--sync-language-data'),
                     ('--preserve-ai', '--include-ai'), ('--include-ai', '--preserve-ai'),
                     ('--sync-language-data', '--preserve-ai'), ('--release-id', 'invalid'), ('--sync-language-db', '--release-id', 'invalid')):
            result = subprocess.run(['bash', str(ROOT / 'commerce-ops/deploy/aws-deploy/deploy.sh'), *args], text=True, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn('Connecting', result.stdout)

    def test_database_export_passes_exact_release_uuid(self):
        identity = 'eeeac359-a115-4df7-a9a7-e5ba310b8815'
        result, calls = self.run_launcher(0, 0, args=('--sync-language-db', '--release-id', identity))
        self.assertEqual(result.returncode, 0, result.stderr)
        export = next(c for c in calls if c[0] == 'node' and any(v.endswith('/export-db-release.ts') for v in c))
        self.assertEqual(export[-2:], ['--release-id', identity])

    def run_launcher(self, failure_code, failures, fail_ssh=False, fail_release=False, args=(),
                     openrsync=False, fail_control_close=False):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); deploy=root/'commerce-ops/deploy/aws-deploy';deploy.mkdir(parents=True);bin_dir=root/'bin';bin_dir.mkdir()
            shutil.copy2(ROOT/'commerce-ops/deploy/aws-deploy/deploy.sh',deploy/'deploy.sh')
            shutil.copytree(ROOT / 'commerce-ops/deploy/ec2/server', root / 'commerce-ops/deploy/ec2/server')
            for name in ('rocento.pem','rocento-origin.pem','rocento-origin.key'):
                (deploy/name).write_text('test placeholder')
            (deploy/'bootstrap.env').write_text('DOMAIN=rocento.com\n');(deploy/'bootstrap.env').chmod(0o600)
            runner='''#!/usr/bin/env python3
import json,os,sys
from pathlib import Path
name=Path(sys.argv[0]).name
with open(os.environ['FAKE_LOG'],'a') as f:f.write(json.dumps([name,*sys.argv[1:]])+'\\n')
if name=='stat':print('600')
if name=='node' and os.environ['FAKE_RELEASE_FAILURE']=='1':sys.exit(1)
if name=='ssh' and os.environ['FAKE_SSH_FAILURE']=='1' and '-O' not in sys.argv:sys.exit(255)
if name=='ssh' and os.environ['FAKE_CONTROL_CLOSE_FAILURE']=='1' and '-O' in sys.argv:sys.exit(255)
if name=='ssh' and 'runner.py status ' in sys.argv[-1]:
 print(json.dumps({'state':'complete','exit_code':0,'offset':0,'output':'','more':False}))
if name=='rsync':
 if '--version' in sys.argv:
  print('openrsync: protocol version 29' if os.environ['FAKE_OPENRSYNC']=='1' else 'rsync  version 3.4.1  protocol version 32')
  sys.exit(0)
 p=Path(os.environ['FAKE_COUNT']);n=int(p.read_text()) if p.exists() else 0;p.write_text(str(n+1))
 if n<int(os.environ['FAKE_FAILURES']):sys.exit(int(os.environ['FAKE_EXIT']))
'''
            for name in ('ssh','scp','rsync','stat','sleep','node'):
                p=bin_dir/name;p.write_text(runner);p.chmod(0o755)
            env={**os.environ,'PATH':str(bin_dir)+os.pathsep+os.environ['PATH'],'FAKE_LOG':str(root/'calls.jsonl'),'FAKE_COUNT':str(root/'count'),'FAKE_FAILURES':str(failures),'FAKE_EXIT':str(failure_code)}
            env['FAKE_SSH_FAILURE']='1' if fail_ssh else '0'
            env['FAKE_RELEASE_FAILURE']='1' if fail_release else '0'
            env['FAKE_OPENRSYNC']='1' if openrsync else '0'
            env['FAKE_CONTROL_CLOSE_FAILURE']='1' if fail_control_close else '0'
            result=subprocess.run(['bash',str(deploy/'deploy.sh'),*args],env=env,text=True,capture_output=True,timeout=20)
            calls=[json.loads(l) for l in (root/'calls.jsonl').read_text().splitlines()]
            return result,calls

    def test_invalid_release_stops_before_remote_changes(self):
        result,calls=self.run_launcher(0,0,fail_release=True)
        self.assertNotEqual(result.returncode,0)
        self.assertIn('--sync-language-data',result.stderr)
        self.assertTrue(any(c[0]=='node' and c[-1].endswith('check-release.ts') for c in calls))
        self.assertFalse(any(c[0] in ('ssh','scp','rsync') for c in calls))

    def test_interrupted_upload_resumes_and_deploys_once_without_seeding(self):
        result,calls=self.run_launcher(255,1)
        self.assertEqual(result.returncode,0,result.stderr)
        uploads=[c for c in rsync_transfers(calls) if '--exclude=/commerce-api/rocento-api/migrations/' in c]
        self.assertEqual(len(uploads),2)
        self.assertIn('--exclude=/Rocento-Codex/',uploads[0])
        self.assertIn('--partial',uploads[0])
        self.assertIn('--exclude=/commerce-api/rocento-api/migrations/', uploads[0])
        mirrors = [c for c in calls if c[0] == 'rsync' and '--delete' in c]
        self.assertEqual(len(mirrors), 1)
        self.assertNotIn('--backup', mirrors[0])
        self.assertTrue(mirrors[0][-2].endswith('/commerce-api/rocento-api/migrations/'))
        self.assertTrue(mirrors[0][-1].endswith('/source/commerce-api/rocento-api/migrations/'))
        self.assertIn('--copy-dest=/opt/rocento/commerce-api/rocento-api/migrations', mirrors[0])
        transport=uploads[0][uploads[0].index('-e')+1]
        self.assertIn('ControlPath=',transport)
        controls=[a for c in calls if c[0] in ('ssh','scp') for a in c if a.startswith('ControlPath=') and a != 'ControlPath=none']
        self.assertEqual(len(set(controls)),1)
        self.assertIn(controls[0],transport)
        seeds=[c for c in calls if c[0]=='ssh' and 'ec2-deploy-job.py start ' in c[-1]]
        self.assertEqual(len(seeds),1)
        self.assertNotIn('--skip-seed',seeds[0][-1])
        self.assertIn('ControlPath=none', seeds[0])
        self.assertFalse(any('ec2-seed-demo.sh' in c[-1] for c in calls if c[0] == 'ssh'))
        self.assertFalse(any('.seeded' in c[-1] for c in calls if c[0] == 'ssh'))

    def test_repeated_network_failure_stops_before_remote_seed(self):
        result,calls=self.run_launcher(255,5)
        self.assertEqual(result.returncode,255)
        self.assertEqual(len(rsync_transfers(calls)),3)
        self.assertFalse(any('ec2-deploy-job.py start ' in c[-1] for c in calls))
        self.assertIn('source-upload',result.stderr)

    def test_permanent_transfer_error_still_fails_after_comparison_fallback(self):
        result,calls=self.run_launcher(23,5)
        self.assertEqual(result.returncode,23)
        self.assertEqual(len(rsync_transfers(calls)),2)
        self.assertIn('--copy-dest=/opt/rocento', rsync_transfers(calls)[0])
        self.assertFalse(any(arg.startswith('--copy-dest=') for arg in rsync_transfers(calls)[1]))
        self.assertFalse(any('ec2-deploy-job.py start ' in c[-1] for c in calls))
        # The one close is final cleanup; permanent transfer errors are not reset/retried.
        self.assertEqual(sum(c[0] == 'ssh' and '-O' in c for c in calls), 1)

    def test_unreadable_comparison_tree_falls_back_without_changing_live_permissions(self):
        result, calls = self.run_launcher(23, 1)
        self.assertEqual(result.returncode, 0, result.stderr)
        transfers = rsync_transfers(calls)
        self.assertEqual(len(transfers), 3)
        self.assertIn('--copy-dest=/opt/rocento', transfers[0])
        self.assertFalse(any(arg.startswith('--copy-dest=') for arg in transfers[1]))
        self.assertEqual(transfers[0][-1], transfers[1][-1])
        self.assertFalse(any('chown' in c[-1] for c in calls if c[0] == 'ssh'))

    def test_uploads_and_configuration_are_isolated_until_job_launch(self):
        result, calls = self.run_launcher(0, 0)
        self.assertEqual(result.returncode, 0, result.stderr)
        transfers = rsync_transfers(calls)
        stage = transfers[0][-1].split(':', 1)[1].removesuffix('/source/')
        self.assertTrue(stage.startswith('/home/ubuntu/.rocento-deploy/'))
        self.assertTrue(all(c[-1].startswith('ubuntu@3.78.102.161:' + stage + '/')
                            for c in transfers + [c for c in calls if c[0] == 'scp']))
        self.assertIn('--copy-dest=/opt/rocento', transfers[0])
        remote_commands = [c[-1] for c in calls if c[0] == 'ssh' and '-O' not in c]
        self.assertFalse(any('sudo install' in c or 'chown' in c or 'rm -rf' in c for c in remote_commands))
        launch = next(c for c in remote_commands if 'ec2-deploy-job.py start ' in c)
        self.assertIn(stage + '/source/commerce-ops/deploy/ec2/server/ec2-deploy-job.py', launch)
        self.assertIn('--source ' + stage, launch)
        ready = next(i for i, c in enumerate(calls) if c[0] == 'ssh' and "touch '" + stage + "/ready'" in c[-1])
        self.assertLess(max(i for i, c in enumerate(calls) if c[0] == 'scp'), ready)
        self.assertLess(ready, next(i for i, c in enumerate(calls) if c[0] == 'ssh' and 'ec2-deploy-job.py start ' in c[-1]))

    def test_protocol_eof_reconnects_before_resuming_and_deploys_once(self):
        result, calls = self.run_launcher(12, 1)
        self.assertEqual(result.returncode, 0, result.stderr)
        uploads = [c for c in rsync_transfers(calls) if '--exclude=/commerce-api/rocento-api/migrations/' in c]
        self.assertEqual(len(uploads), 2)
        self.assertTrue(all('--partial' in c and '--partial-dir=.rsync-partial' in c for c in uploads))
        positions = [i for i, c in enumerate(calls) if c[0] == 'rsync' and '--version' not in c and '--delete' not in c]
        resets = [c for c in calls[positions[0] + 1:positions[1]] if c[0] == 'ssh' and '-O' in c]
        self.assertEqual(len(resets), 1)
        self.assertEqual(resets[0][resets[0].index('-O') + 1], 'exit')
        socket = resets[0][resets[0].index('-S') + 1]
        self.assertIn('ControlPath=' + socket, uploads[0][uploads[0].index('-e') + 1])
        self.assertEqual(sum('--delete' in c for c in rsync_transfers(calls)), 1)
        self.assertEqual(sum(c[0] == 'ssh' and 'ec2-deploy-job.py start ' in c[-1] for c in calls), 1)
        self.assertIn('exit 12', result.stdout)

    def test_repeated_protocol_eof_preserves_exit_code_and_stops_before_deploy(self):
        result, calls = self.run_launcher(12, 5)
        self.assertEqual(result.returncode, 12, result.stderr)
        self.assertEqual(len(rsync_transfers(calls)), 3)
        self.assertFalse(any('--delete' in c for c in rsync_transfers(calls)))
        self.assertFalse(any(c[0] == 'scp' for c in calls))
        self.assertFalse(any(c[0] == 'ssh' and 'ec2-deploy-job.py start ' in c[-1] for c in calls))
        self.assertEqual(sum(c[0] == 'ssh' and '-O' in c for c in calls), 3)
        self.assertIn('source-upload (exit 12)', result.stderr)

    def test_missing_control_connection_does_not_prevent_retry(self):
        result, calls = self.run_launcher(12, 1, fail_control_close=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len([c for c in rsync_transfers(calls) if '--exclude=/commerce-api/rocento-api/migrations/' in c]), 2)
        self.assertEqual(sum(c[0] == 'ssh' and '-O' in c for c in calls), 2)
        self.assertEqual(sum(c[0] == 'ssh' and 'ec2-deploy-job.py start ' in c[-1] for c in calls), 1)

    def test_openrsync_uses_uncompressed_transfer_options(self):
        result, calls = self.run_launcher(0, 0, openrsync=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        uploads = rsync_transfers(calls)
        self.assertEqual(len(uploads), 2)
        for upload in uploads:
            self.assertIn('-a', upload)
            self.assertNotIn('-az', upload)
            self.assertNotIn('--compress', upload)
            self.assertIn('--partial', upload)

    def test_upstream_rsync_retains_compressed_transfer_options(self):
        result, calls = self.run_launcher(0, 0)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(rsync_transfers(calls)), 2)
        self.assertTrue(all('-az' in c for c in rsync_transfers(calls)))

    def test_initial_ssh_failure_reports_seed_never_started(self):
        result,calls=self.run_launcher(0,0,fail_ssh=True)
        self.assertEqual(result.returncode,255)
        self.assertIn('ssh-connection',result.stderr)
        self.assertIn('No source upload or demo seeding started',result.stderr)
        self.assertFalse(rsync_transfers(calls))
        self.assertFalse(any(c[0] == 'scp' for c in calls))
        self.assertFalse(any('ec2-deploy-job.py start ' in c[-1] for c in calls))

    def test_preview_only_reads_remote_and_dry_runs_both_transfers(self):
        result, calls = self.run_launcher(0, 0, args=('--dry-run',))
        self.assertEqual(result.returncode, 0, result.stderr)
        uploads = rsync_transfers(calls)
        self.assertEqual(len(uploads), 2)
        self.assertTrue(all('--dry-run' in c and '--itemize-changes' in c for c in uploads))
        self.assertIn('--delete', uploads[1])
        self.assertEqual([c[-1] for c in calls if c[0] == 'ssh' and '-O' not in c], ["test -d '/opt/rocento'"])
        self.assertFalse(any(c[0] == 'scp' for c in calls))
        self.assertIn('remote build was not started', result.stdout)

    def test_preview_protocol_retry_stays_read_only(self):
        result, calls = self.run_launcher(12, 1, args=('--dry-run',))
        self.assertEqual(result.returncode, 0, result.stderr)
        uploads = rsync_transfers(calls)
        self.assertEqual(len(uploads), 3)
        self.assertTrue(all('--dry-run' in c and '--itemize-changes' in c for c in uploads))
        self.assertEqual(sum('--delete' in c for c in uploads), 3)
        self.assertEqual([c[-1] for c in calls if c[0] == 'ssh' and '-O' not in c], ["test -d '/opt/rocento'"])
        self.assertFalse(any(c[0] == 'scp' for c in calls))
        self.assertEqual(sum(c[0] == 'ssh' and '-O' in c for c in calls), 2)
        self.assertIn('remote build was not started', result.stdout)

    def test_preview_rejects_language_export_before_any_command(self):
        result = subprocess.run(
            ['bash', str(ROOT / 'commerce-ops/deploy/aws-deploy/deploy.sh'), '--dry-run', '--sync-language-db'],
            text=True, capture_output=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('--dry-run cannot export language data', result.stderr)

    def test_real_rsync_filters_and_incremental_upload_preserve_runtime_data(self):
        if not shutil.which('rsync'):
            self.skipTest('rsync is unavailable')
        result, calls = self.run_launcher(0, 0, args=('--include-ai',))
        self.assertEqual(result.returncode, 0, result.stderr)
        upload = next(c for c in rsync_transfers(calls) if '--exclude=/commerce-api/rocento-api/migrations/' in c)
        options = upload[1:-2]
        transport = options.index('-e')
        del options[transport:transport + 2]
        options.remove('--progress')
        options = [option for option in options if not option.startswith('--copy-dest=')]
        with tempfile.TemporaryDirectory() as directory:
            source, remote = Path(directory) / 'source', Path(directory) / 'remote'
            source.mkdir(); remote.mkdir()
            included = [
                'commerce-api/rocento-api/crates/api-gateway/src/main.rs', 'commerce-api/rocento-api/openapi.json',
                'commerce-web/apps/storefront/src/attribute-filters.test.ts',
                'commerce-web/apps/website/public/images/grocery.webp',
                'commerce-web/packages/ui/src/logo.webp', 'commerce-web/pnpm-lock.yaml',
                'commerce-assistant-platform/Dockerfile', 'commerce-assistant-platform/.dockerignore', 'commerce-assistant-platform/requirements.lock',
                'commerce-assistant-platform/app/main.py', 'commerce-assistant-platform/knowledge/catalog.md',
                'commerce-assistant-platform/app/commerce_resolution_engine/language.py',
                'commerce-assistant-platform/app/commerce_resolution_engine/providers/openai.py',
                'commerce-assistant-platform/app/commerce_contracts/language_proposal.py',
                'commerce-assistant-platform/app/commerce_action_engine/execution/language/proposals.py',
                'commerce-assistant-platform/app/commerce_action_engine/platform/store.py',
                'commerce-assistant-platform/migrations/008_assistant_tracking.sql',
                'commerce-assistant-platform/knowledge/intent-examples.discovery-v2.en.json',
                'commerce-api/rocento-api/crates/api-gateway/src/assistant_tracking.rs',
                'commerce-web/apps/admin/src/main.tsx',
                'commerce-web/apps/admin/src/permission-model.ts',
                'commerce-ops/deploy/assistant/ingress.conf', 'commerce-ops/scripts/conversations-setup.py',
                'commerce-ops/scripts/agentic-preflight.py',
                'commerce-assistant-platform/app/commerce_language_engine/data/compiled.json',
                'commerce-assistant-platform/app/commerce_language_engine/data/deployment-release.json.gz',
                'commerce-assistant-platform/app/commerce_language_engine/src/runtime.ts',
                'commerce-ops/deploy/ec2/configure.py', 'commerce-ops/deploy/assistant/tools.conf',
                'commerce-ops/deploy/ec2/server/ec2-up.sh', 'commerce-ops/deploy/ec2/server/ec2-source-filters.sh',
                'commerce-ops/deploy/ec2/server/ec2-deploy-job.py', 'commerce-ops/deploy/ec2/server/cleanup.py',
                'commerce-api/rocento-api/crates/commerce-core-contracts/contract/v1/schema.json',
                'commerce-assistant-platform/contracts/commerce-meaning/v1/schema.json', 'commerce-ops/compose/compose.yaml', 'commerce-ops/compose/compose.language-engine.yaml',
            ]
            excluded = [
                'commerce-assets/demo/products.png', 'commerce-demo/grocery/theme.json',
                'commerce-mobile-apps/pubspec.yaml', 'commerce-mobile-apps/lib/main.dart', 'commerce-mobile-apps/build/app.apk',
                'rocento-mobile-specs/README.md',
                'commerce-docs/report.md', 'examples/data.json', 'Rocento-Codex/Quality/big.json',
                'commerce-ops/deploy/aws-deploy/rocento.pem', 'artifacts/report.json', '.env', 'unexpected-local/data.bin',
                'commerce-ops/deploy/aws-deploy/deploy.sh',
                'commerce-ops/deploy/aws-deploy/bootstrap.env', 'commerce-ops/deploy/aws-automation/controller.py',
                'commerce-api/rocento-api/target/release/api', 'commerce-api/rocento-api/migrations/old.sql',
                'commerce-web/node_modules/vite/index.js', 'commerce-web/apps/storefront/dist/index.html',
                'commerce-web/apps/storefront/dist-server/server.js', 'commerce-web/apps/website/.next/cache/file',
                'commerce-web/apps/storefront/.stage1-dist/index.html',
                'commerce-web/apps/storefront/.env.production', 'commerce-web/test-results/report.json',
                'commerce-assistant-platform/app/__pycache__/main.pyc', 'commerce-assistant-platform/docs/report.md',
                'commerce-assistant-platform/app/commerce_language_engine/data/corpus.jsonl',
                'commerce-assistant-platform/app/commerce_language_engine/data/backups/compiled.json',
                'commerce-ops/deploy/ec2/bootstrap.env', 'commerce-ops/deploy/ec2/grocery.env',
                'deploy/ec2/assistant/grocery/private.pem', 'deploy/ec2/state/frontend.sha256',
                'deploy/ec2/public/index.html', 'deploy/ec2/setup.lock', 'deploy/ec2/card-details.ABC123/private.json',
            ]
            for name in included + excluded:
                path = source / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('local fixture')
            protected = ['deploy/ec2/bootstrap.env', 'deploy/ec2/assistant/grocery/private.pem',
                         'deploy/ec2/card-details.ABC123/private.json',
                         'deploy/ec2/state/frontend.sha256', 'uploads/customer.jpg', 'commerce-api/rocento-api/migrations/old.sql']
            for name in protected:
                path = remote / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('existing production value')

            def sync(extra=()):
                run = subprocess.run(['rsync', *options, *extra, str(source) + '/', str(remote) + '/'], text=True, capture_output=True)
                self.assertEqual(run.returncode, 0, run.stderr)
                return run.stdout

            sync()
            for name in included:
                self.assertEqual((remote / name).read_text(), 'local fixture', name)
            for name in excluded:
                if name not in protected:
                    self.assertFalse((remote / name).exists(), name)
            for name in protected:
                self.assertEqual((remote / name).read_text(), 'existing production value', name)
            # A second run skips all file payloads; a subsequent source edit
            # transfers only the changed file and leaves unrelated files intact.
            self.assertNotIn('>f', sync(('--itemize-changes',)))
            changed = source / included[0]
            changed.write_text('updated application fixture with a new size')
            output = sync(('--itemize-changes',))
            self.assertEqual(sum('>f' in line for line in output.splitlines()), 1, output)
            self.assertEqual((remote / included[0]).read_bytes(), changed.read_bytes())

    def test_real_preview_does_not_write_or_delete_migrations(self):
        if not shutil.which('rsync'):
            self.skipTest('rsync is unavailable')
        result, calls = self.run_launcher(0, 0, args=('--dry-run',))
        self.assertEqual(result.returncode, 0, result.stderr)
        mirror = next(c for c in calls if c[0] == 'rsync' and c[-2].endswith('/commerce-api/rocento-api/migrations/'))
        options = mirror[1:-2]
        transport = options.index('-e')
        del options[transport:transport + 2]
        with tempfile.TemporaryDirectory() as directory:
            source, remote = Path(directory) / 'source', Path(directory) / 'remote'
            source.mkdir(); remote.mkdir()
            (source / 'new.sql').write_text('new migration')
            (remote / 'old.sql').write_text('existing migration')
            run = subprocess.run(['rsync', *options, str(source) + '/', str(remote) + '/'], text=True, capture_output=True)
            self.assertEqual(run.returncode, 0, run.stderr)
            self.assertIn('old.sql', run.stdout)
            self.assertIn('new.sql', run.stdout)
            self.assertFalse((remote / 'new.sql').exists())
            self.assertEqual((remote / 'old.sql').read_text(), 'existing migration')

if __name__=='__main__':unittest.main()
