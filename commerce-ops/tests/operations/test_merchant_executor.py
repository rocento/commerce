import importlib.util
import hashlib
import json
from pathlib import Path
import tempfile
import time
import subprocess
import sys
import unittest
import urllib.error
from unittest.mock import patch
from unittest.mock import MagicMock
import uuid
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('merchant_executor', ROOT / 'commerce-ops/cloud/host/merchant_executor.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class MerchantExecutorTests(unittest.TestCase):
    def test_starter_assets_and_categories_resolve_and_resume_without_reupload(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            release = directory / 'release'
            (release / 'artifacts/themes').mkdir(parents=True)
            asset = release / 'artifacts/theme-assets/jewelry/ring.png'
            asset.parent.mkdir(parents=True)
            asset.write_bytes(b'fixture-png')
            checksum = hashlib.sha256(asset.read_bytes()).hexdigest()
            dependencies = {'assets': ['jewelry/ring.png'], 'categories': {'rings': {'slug': 'rings', 'name': 'Rings'}}}
            name = 'themes/jewelry.dependencies.json'
            (release / 'artifacts' / name).write_text(json.dumps(dependencies))
            inventory = {'files': {name: 'fixture', 'theme-assets/jewelry/ring.png': checksum}}
            category_id, media_id = str(uuid.uuid4()), str(uuid.uuid4())
            categories = []
            uploads = []
            def api(method, path, body=None, **kwargs):
                if method == 'GET': return categories
                if path.endswith('/categories'):
                    categories.append(dict(body, id=category_id))
                    return categories[-1]
                self.assertEqual(path, '/v1/admin/catalog/media')
                self.assertIn(b'fixture-png', body)
                self.assertTrue(kwargs['content_type'].startswith('multipart/form-data; boundary='))
                uploads.append(body)
                return {'id': media_id}
            configuration = {'image': 'asset:jewelry/ring.png', 'category': 'category:rings', 'href': 'category-link:rings'}
            with patch.object(m, 'trusted', side_effect=lambda path: path):
                first = m.resolve_starter_theme(directory, release, inventory, 'jewelry', configuration, api)
                second = m.resolve_starter_theme(directory, release, inventory, 'jewelry', configuration, api)
                self.assertEqual(first, {'image': media_id, 'category': category_id, 'href': '/categories/' + category_id})
                self.assertEqual(first, second)
                self.assertEqual(len(uploads), 1)
                self.assertEqual(len(categories), 1)
                asset.write_bytes(b'changed')
                with self.assertRaisesRegex(ValueError, 'STARTER_ASSET_CHANGED'):
                    m.resolve_starter_theme(directory, release, inventory, 'jewelry', configuration, api)

    def setUp(self):
        self.job = dict(id=str(uuid.uuid4()), tenantId=str(uuid.uuid4()), paymentRequestId=str(uuid.uuid4()),
                        leaseToken=str(uuid.uuid4()), themeId='grocery', step='RELEASE', releaseVersion='grocery-v1',
                        artifactDigest='sha256:' + 'a'*64, storefrontHost='test.rocento.com', adminHost='test-admin.rocento.com')
        self.binding = dict(self.job, gatewayPort=18000, adminEmail='tester@example.test', environment='fixture', expiresAt=time.time()+175)
        self.request = dict(schemaVersion=2, operation='execute', job=self.job, idempotencyKey=self.job['id'] + ':RELEASE')
        self.inventory = dict(images={key: 'sha256:' + 'b'*64 for key in ('api','postgres','nats','meili','minio','clickhouse')})

    def test_all_four_themes_validate_and_install_the_selected_industry(self):
        for theme in m.SUPPORTED_THEMES:
            with self.subTest(theme=theme):
                job = dict(self.job, themeId=theme)
                binding = dict(self.binding, themeId=theme)
                m.validate_request(dict(self.request, job=job), {job['tenantId']: binding})
                with tempfile.TemporaryDirectory() as directory, patch.object(m, 'compose', side_effect=[b'', str(uuid.uuid4()).encode()]) as compose:
                    m.migrate_runtime(Path(directory), theme)
                    args = compose.call_args_list[0].args
                    self.assertEqual(args[args.index('--industry') + 1], theme)
        with patch.object(m, 'compose') as compose, self.assertRaisesRegex(ValueError, 'UNSUPPORTED_INDUSTRY'):
            m.migrate_runtime(Path('/unused'), '../jewelry')
        compose.assert_not_called()

    def test_bundle_requires_exact_theme_artifacts_and_preserves_legacy(self):
        inventory = {'schemaVersion': 2, 'themes': list(m.SUPPORTED_THEMES)}
        self.assertEqual(m.required_artifacts(inventory), {'storefront/index.html', 'admin/index.html',
            'themes/grocery.json', 'themes/jewelry.json', 'themes/electronics.json', 'themes/pharmacy.json'})
        self.assertEqual(m.theme_artifact({'schemaVersion': 1, 'theme': 'grocery'}, 'grocery'), 'theme.json')
        with self.assertRaisesRegex(ValueError, 'RELEASE_THEME_MISMATCH'):
            m.theme_artifact({'schemaVersion': 1, 'theme': 'grocery'}, 'jewelry')
        for themes in ([], ['grocery', 'grocery'], ['../jewelry'], 'grocery', [None]):
            with self.subTest(themes=themes), self.assertRaisesRegex(ValueError, 'INVALID_RELEASE_THEMES'):
                m.release_themes({'schemaVersion': 2, 'themes': themes})

    def test_payment_binding_rejects_other_tenant_and_release(self):
        m.validate_request(self.request, {self.job['tenantId']: self.binding})
        with self.assertRaises(m.Blocked):
            m.validate_request(self.request, {})
        binding = dict(self.binding, artifactDigest='sha256:' + 'c'*64)
        with self.assertRaises(m.Blocked):
            m.validate_request(self.request, {self.job['tenantId']: binding})

    def test_bootstrap_publishes_the_selected_bundle_theme(self):
        inventory = {'schemaVersion': 2, 'themes': list(m.SUPPORTED_THEMES)}
        for selected in m.SUPPORTED_THEMES:
            with self.subTest(theme=selected):
                configuration = {'selected': selected}
                release = Path('/fixture/release')
                def read(path):
                    if path.name == 'credentials.json':
                        return {'ADMIN_PASSWORD': 'fixture-only'}
                    if path.name == 'inventory.json':
                        return inventory
                    self.assertEqual(path, release / 'artifacts/themes' / (selected + '.json'))
                    return configuration
                def api(method, path, data=None):
                    if method == 'GET' and path.endswith('/assignments'):
                        return [{'channel': 'storefront', 'revision': 1, 'theme_id': None}]
                    if method == 'GET':
                        return []
                    if method == 'POST' and path.endswith('/themes'):
                        self.assertEqual(data['name'], selected.capitalize() + ' starter')
                        return {'id': 'selected', 'revision': 1}
                    if method == 'PUT' and path.endswith('/themes/selected'):
                        self.assertEqual(data['configuration'], configuration)
                        return {'id': 'selected', 'revision': 2}
                    return {}
                call = MagicMock(side_effect=api)
                with patch.object(m, 'read_json', side_effect=read), patch.object(m, 'compose', return_value=b'1'), patch.object(m, 'api_client', return_value=call):
                    m.bootstrap(Path('/fixture/tenant'), dict(self.binding, themeId=selected), release)
                call.assert_any_call('POST', '/v1/admin/themes/selected/publish', {'expected_revision': 2})

    def test_input_paths_and_idempotency_are_not_trusted(self):
        for field, value in [('id', '../root'), ('storefrontHost', 'test.rocento.com;sh'), ('step', 'SHELL')]:
            request = dict(self.request, job=dict(self.job, **{field:value}))
            with self.assertRaises((ValueError, m.Blocked)):
                m.validate_request(request, {self.job['tenantId']: self.binding})
        with self.assertRaises(ValueError):
            m.validate_request(dict(self.request, idempotencyKey='other'), {self.job['tenantId']: self.binding})

    def test_duplicate_json_fields_rejected(self):
        with self.assertRaises(ValueError):
            json.loads('{"job":1,"job":2}', object_pairs_hook=m.unique)

    def test_release_template_drift_blocks_before_runtime_commands(self):
        inventory = dict(self.inventory, theme='grocery', version=self.job['releaseVersion'],
                         tools={'executor': 'executor-sha', 'templates': 'approved-template-sha'})
        spec = SimpleNamespace(loader=MagicMock())
        policy = SimpleNamespace(validate=lambda *args: [])
        def checksum(path):
            if path.name == 'inventory.json':
                return self.job['artifactDigest'][7:]
            if path == m.TEMPLATES:
                return 'changed-template-sha'
            return 'executor-sha'
        with patch.object(m.Path, 'exists', return_value=True), \
             patch.object(m, 'read_json', side_effect=[inventory, {}]), \
             patch.object(m, 'trusted', side_effect=lambda path: path), \
             patch.object(m, 'sha', side_effect=checksum), \
             patch.object(m.importlib.util, 'spec_from_file_location', return_value=spec), \
             patch.object(m.importlib.util, 'module_from_spec', return_value=policy), \
             patch.object(m, 'command') as command:
            with self.assertRaisesRegex(ValueError, 'EXECUTOR_RELEASE_CHANGED'):
                m.authorized_release(self.job, self.binding, runtime=False)
            command.assert_not_called()

    def test_uninventoried_symlink_artifacts_are_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            artifacts = root / 'artifacts'
            artifacts.mkdir()
            (artifacts / 'index.html').write_text('fixture')
            outside = root / 'private'
            outside.mkdir()
            (outside / 'hidden.txt').write_text('not-an-artifact')
            self.assertEqual(m.artifact_files(artifacts), {'index.html'})
            for target in (outside, outside / 'hidden.txt', root / 'missing'):
                link = artifacts / 'unlisted'
                link.symlink_to(target)
                with self.assertRaisesRegex(ValueError, 'ARTIFACT_SYMLINK'):
                    m.artifact_files(artifacts)
                link.unlink()
            linked_root = root / 'linked-artifacts'
            linked_root.symlink_to(artifacts)
            with self.assertRaisesRegex(ValueError, 'ARTIFACT_SYMLINK'):
                m.artifact_files(linked_root)

    def test_private_isolated_topology_uses_only_pinned_images(self):
        result = m.render_compose(self.job, self.binding, self.inventory)
        self.assertEqual(len(result['services']), 10)
        for name, service in result['services'].items():
            self.assertTrue(service['image'].startswith('sha256:'))
            self.assertEqual(service['networks'], ['tenant'])
            self.assertNotIn('network_mode', service)
            self.assertNotIn('privileged', service)
            if name != 'api-gateway':
                self.assertNotIn('ports', service)
        self.assertEqual(result['services']['api-gateway']['ports'], ['127.0.0.1:18000:8080'])
        self.assertEqual(result['services']['api-gateway']['environment']['AUTH_IP_RATE_LIMIT_MODE'], 'ingress')
        self.assertNotIn('docker.sock', json.dumps(result))

    def test_nginx_publishes_only_exact_bound_hostnames(self):
        result = m.nginx_config(self.job, self.binding, Path('/approved/release'))
        self.assertIn('server_name test.rocento.com;', result)
        self.assertIn('server_name test-admin.rocento.com;', result)
        self.assertNotIn('server_name *', result)
        self.assertIn(self.job['tenantId'], result)
        self.assertIn(self.job['artifactDigest'], result)
        self.assertIn('proxy_pass http://127.0.0.1:18000/;', result)

    def test_production_gateway_binds_only_the_reviewed_readonly_artifact(self):
        gateway = m.render_compose(self.job, self.binding, self.inventory)['services']['api-gateway']
        env = gateway['environment']
        self.assertEqual(env['APP_ENV'], 'production')
        self.assertEqual(env['PUBLICATION_ENVIRONMENT'], 'production')
        self.assertEqual(env['PUBLICATION_APPROVED_ORIGIN'], 'https://test.rocento.com/')
        self.assertEqual(env['PUBLICATION_INSTALLATION_ID'], '${PUBLICATION_INSTALLATION_ID:-}')
        self.assertEqual(env['PUBLICATION_NOINDEX'], 'true')
        self.assertEqual(gateway['volumes'], [{
            'type': 'bind', 'source': str(m.CONFIG / 'releases' / ('a'*64) / 'artifacts/storefront/index.html'),
            'target': '/srv/publication/index.html', 'read_only': True,
            'bind': {'create_host_path': False}}])

    def test_database_identity_is_bound_before_gateway_start_and_preserved(self):
        identity = str(uuid.uuid4())
        with tempfile.TemporaryDirectory() as root, patch.object(m, 'trusted', side_effect=Path):
            root = Path(root)
            with patch.object(m, 'compose', side_effect=[b'', b'', (identity+'\n').encode(), b'']) as compose:
                m.start_runtime(root)
                self.assertEqual(compose.call_args_list[0].args[-1], 'postgres')
                self.assertIn('install-catalog-data', compose.call_args_list[1].args)
                self.assertIn('SELECT installation_id', compose.call_args_list[2].args[-1])
                self.assertEqual(compose.call_args_list[3].args[-1], '80')
            self.assertEqual((root/'publication.env').read_text(), 'PUBLICATION_INSTALLATION_ID='+identity+'\n')
            original = (root/'publication.env').read_bytes()
            with patch.object(m, 'compose', side_effect=[b'', b'', (identity+'\n').encode(), b'']):
                m.start_runtime(root)
            self.assertEqual((root/'publication.env').read_bytes(), original)
            for changed in (str(uuid.uuid4()), '', 'not-a-uuid', identity+'\n'+identity):
                with patch.object(m, 'compose', side_effect=[b'', b'', changed.encode()]) as compose:
                    with self.assertRaises(ValueError):
                        m.start_runtime(root)
                    self.assertEqual(compose.call_count, 3)
                self.assertEqual((root/'publication.env').read_bytes(), original)

    def test_migration_failure_never_starts_gateway(self):
        with tempfile.TemporaryDirectory() as root, patch.object(m, 'compose', side_effect=[b'', RuntimeError('migration failed')]) as compose:
            with self.assertRaises(RuntimeError):
                m.start_runtime(Path(root))
            self.assertEqual(compose.call_count, 2)
            self.assertFalse((Path(root)/'publication.env').exists())

    def test_compose_loads_persisted_publication_binding(self):
        with tempfile.TemporaryDirectory() as root, patch.object(m, 'trusted', side_effect=Path), patch.object(m, 'command', return_value=b'') as command:
            root = Path(root)
            m.compose(root, 'ps')
            self.assertNotIn(str(root/'publication.env'), command.call_args.args[0])
            (root/'publication.env').write_text('PUBLICATION_INSTALLATION_ID='+str(uuid.uuid4())+'\n')
            m.compose(root, 'ps')
            args = command.call_args.args[0]
            self.assertGreater(args.index(str(root/'publication.env')), args.index(str(root/'runtime.env')))

    def test_isolation_rejects_writable_or_foreign_publication_mounts(self):
        project = 'merchant-' + self.job['tenantId']
        services = m.render_compose(self.job, self.binding, self.inventory)['services']
        containers = [dict(Config={'Labels': {'com.docker.compose.service': name,
                         'com.docker.compose.project': project}},
                         HostConfig={'Privileged': False, 'PortBindings': {}},
                         NetworkSettings={'Networks': {project+'_tenant': {}}},
                         Mounts=[], Image=service['image'], State={'Running': True})
                      for name, service in services.items()]
        gateway = next(c for c in containers if c['Config']['Labels']['com.docker.compose.service'] == 'api-gateway')
        mount = dict(Type='bind', Source=str(m.publication_artifact(self.job)),
                     Destination='/srv/publication/index.html', RW=False)
        gateway['Mounts'] = [mount]
        with patch.object(m, 'compose', return_value=b'ids'), patch.object(m, 'command', return_value=json.dumps(containers).encode()):
            m.check_isolation(Path('/unused'), self.inventory, self.job)
        for mounts in ([], [dict(mount, RW=True)], [dict(mount, Source='/etc/passwd')],
                       [dict(mount, Destination='/etc/config')]):
            gateway['Mounts'] = mounts
            with patch.object(m, 'compose', return_value=b'ids'), patch.object(m, 'command', return_value=json.dumps(containers).encode()):
                with self.assertRaises(ValueError):
                    m.check_isolation(Path('/unused'), self.inventory, self.job)

    def test_search_indexing_budget_fits_existing_tenant_limit(self):
        compose = m.render_compose(self.job, self.binding, self.inventory)
        search = compose['services']['meilisearch']
        self.assertEqual(search['mem_limit'], '512m')
        self.assertEqual(search['pids_limit'], 256)
        self.assertEqual(search['environment']['MEILI_MAX_INDEXING_THREADS'], '1')
        budget = int(search['environment']['MEILI_MAX_INDEXING_MEMORY'])
        self.assertGreater(budget, 0)
        self.assertLessEqual(budget, 128 * 1024 * 1024)
        self.assertEqual(search['environment']['MEILI_ENV'], 'production')
        self.assertEqual(search['environment']['MEILI_MASTER_KEY'], '${MEILI_KEY:?}')
        self.assertEqual(search['volumes'], ['meili:/meili_data'])
        self.assertEqual(search['networks'], ['tenant'])
        self.assertNotIn('ports', search)
        self.assertNotIn('command', search)
        self.assertNotIn('entrypoint', search)
        for name, service in compose['services'].items():
            if name != 'meilisearch':
                self.assertNotIn('MEILI_MAX_INDEXING_MEMORY', service['environment'])
                self.assertNotIn('MEILI_MAX_INDEXING_THREADS', service['environment'])

    def test_support_scope_is_unique_per_tenant_without_assistant_signing_configuration(self):
        other = dict(self.job, tenantId=str(uuid.uuid4()))
        scopes = []
        for job in (self.job, other):
            result = m.render_compose(job, dict(self.binding, tenantId=job['tenantId']), self.inventory)
            for name in ('api-gateway', 'analytics-worker', 'engagement-worker', 'export-worker'):
                environment = result['services'][name]['environment']
                self.assertEqual(environment['ASSISTANT_TENANT_ID'], job['tenantId'])
                self.assertEqual(str(uuid.UUID(environment['ASSISTANT_TENANT_ID'])), job['tenantId'])
                # A tenant scope alone enables support routes; signing keys/endpoints
                # would enable unrelated assistant infrastructure and are not supplied.
                self.assertEqual({key for key in environment if key.startswith('ASSISTANT_')},
                                 {'ASSISTANT_TENANT_ID'})
            scopes.append(result['services']['api-gateway']['environment']['ASSISTANT_TENANT_ID'])
        self.assertNotEqual(*scopes)

    def test_nginx_keeps_operational_and_first_party_contracts_private(self):
        result = m.nginx_config(self.job, self.binding, Path('/approved/release'))
        for path in ('metrics', 'openapi.json'):
            self.assertEqual(result.count(f'location = /api/{path} {{ return 404; }}'), 2)
            self.assertEqual(result.count(f'location ^~ /api/{path}/ {{ return 404; }}'), 2)
        storefront, admin = result.split('server_name test-admin.rocento.com;')
        self.assertIn('location ^~ /api/v1/admin/api-reference/ { return 404; }', storefront)
        self.assertNotIn('location ^~ /api/v1/admin/api-reference/', admin)

    def test_unreviewed_release_cannot_run_any_host_mutation(self):
        with tempfile.TemporaryDirectory() as root, patch.object(m, 'CONFIG', Path(root)), patch.object(m, 'command') as command:
            with self.assertRaises(m.Blocked):
                m.authorized_release(self.job, self.binding)
            command.assert_not_called()

    def test_public_probes_identify_service_and_keep_default_tls_timeout(self):
        url = 'https://review-fixture.rocento.com/'
        for operation, body in ((m.fetch_json, b'{"status":"ready"}'),
                                (m.verify_public_page, b'<html>fixture</html>')):
            response = MagicMock(status=200)
            response.__enter__.return_value = response
            response.read.return_value = body
            response.geturl.return_value = url
            with self.subTest(operation=operation.__name__), patch.object(m.urllib.request, 'urlopen', return_value=response) as opened:
                operation(url)
                request = opened.call_args.args[0]
                self.assertEqual(request.full_url, url)
                self.assertEqual(request.get_method(), 'GET')
                self.assertEqual(request.get_header('User-agent'), 'RocentoProvisioning/1.0')
                self.assertEqual(opened.call_args.kwargs, {'timeout': 10})

    def test_public_probe_status_and_redirect_rejections_remain(self):
        response = MagicMock(status=503)
        response.__enter__.return_value = response
        response.read.return_value = b'<html>fixture</html>'
        response.geturl.return_value = 'https://unexpected.example.test/'
        with patch.object(m.urllib.request, 'urlopen', return_value=response):
            with self.assertRaisesRegex(ValueError, 'UNEXPECTED_REDIRECT'):
                m.fetch_json('https://review-fixture.rocento.com/api/ready')
            with self.assertRaisesRegex(ValueError, 'PUBLIC_PAGE_INVALID'):
                m.verify_public_page('https://review-fixture.rocento.com/')
        failure = urllib.error.HTTPError('https://review-fixture.rocento.com/', 403, 'Forbidden', {}, None)
        for operation in (m.fetch_json, m.verify_public_page):
            with patch.object(m.urllib.request, 'urlopen', side_effect=failure), self.assertRaises(urllib.error.HTTPError):
                operation('https://review-fixture.rocento.com/')
        failure.close()

    def test_ports_are_durable_and_distinct(self):
        with tempfile.TemporaryDirectory() as root, patch.object(m, 'STATE', Path(root)), patch.object(m, 'trusted', side_effect=Path):
            a = m.allocate_port(self.job['tenantId'])
            self.assertEqual(a, m.allocate_port(self.job['tenantId']))
            self.assertNotEqual(a, m.allocate_port(str(uuid.uuid4())))
            self.assertNotEqual(a, m.allocate_port(str(uuid.uuid4())))
            with self.assertRaises(m.Blocked):
                m.allocate_port(str(uuid.uuid4()))

    def test_expired_or_unpaid_job_stops_before_release(self):
        with patch.object(m, 'command', return_value=b''):
            with self.assertRaises(m.Blocked):
                m.database_binding(self.request)

    def test_database_lookup_binds_lease_payment_and_step(self):
        with patch.object(m, 'command', return_value=json.dumps(self.binding).encode()) as command:
            m.database_binding(self.request)
            sql = command.call_args.kwargs['data'].decode()
            for text in ("p.status='CONFIRMED'", "j.step='RELEASE'", 'j.lease_until>clock_timestamp()', self.job['leaseToken'], self.job['paymentRequestId']):
                self.assertIn(text, sql)

    def test_bootstrap_secrets_survive_retries_and_reject_rotation(self):
        with tempfile.TemporaryDirectory() as root, patch.object(m, 'CONFIG', Path(root)), patch.object(m, 'trusted', side_effect=Path):
            directory=Path(root)/'tenant';directory.mkdir()
            (Path(root)/'smtp.json').write_text(json.dumps({'SMTP_PASSWORD': 'example$only'}))
            m.prepare_credentials(directory)
            before=(directory/'runtime.env').read_bytes()
            m.prepare_credentials(directory)
            self.assertEqual(before,(directory/'runtime.env').read_bytes())
            credentials = json.loads((directory/'credentials.json').read_text())
            self.assertEqual(len(credentials['META_CREDENTIAL_KEY']), 64)
            second = Path(root)/'second'; second.mkdir()
            m.prepare_credentials(second)
            self.assertNotEqual(credentials['META_CREDENTIAL_KEY'], json.loads((second/'credentials.json').read_text())['META_CREDENTIAL_KEY'])
            self.assertNotIn(b'ADMIN_PASSWORD', before)
            self.assertIn(b"SMTP_PASSWORD='example$only'", before)
            (Path(root)/'smtp.json').write_text(json.dumps({'SMTP_PASSWORD': 'changed'}))
            with self.assertRaises(ValueError):
                m.prepare_credentials(directory)


class CheckpointRecoveryTests(unittest.TestCase):
    def setUp(self):
        MerchantExecutorTests.setUp(self)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for name, value in [('STATE', self.root), ('trusted', lambda p: Path(p)),
                            ('authorized_release', lambda *a: (self.root, self.inventory))]:
            guard = patch.object(m, name, value)
            guard.start(); self.addCleanup(guard.stop)

    def test_completed_receipt_recovers_new_lease_without_repeating_mutation(self):
        with patch.object(m, 'execute_checkpoint') as execute:
            first = m.execute_bound(self.request, dict(self.binding))
            request = dict(self.request, operation='reconcile', job=dict(self.job, leaseToken=str(uuid.uuid4())))
            recovered = m.execute_bound(request, dict(self.binding))
            execute.assert_called_once()
            self.assertNotEqual(first['leaseToken'], recovered['leaseToken'])
            self.assertEqual(recovered['leaseToken'], request['job']['leaseToken'])
            self.assertEqual(first['checks'], recovered['checks'])

    def test_missing_receipt_reconciliation_never_allocates_or_executes(self):
        with patch.object(m, 'execute_checkpoint') as execute, patch.object(m, 'allocate_port') as allocate:
            with self.assertRaisesRegex(ValueError, 'RECEIPT_MISSING'):
                m.execute_bound(dict(self.request, operation='reconcile'), self.binding)
            execute.assert_not_called(); allocate.assert_not_called()
            self.assertFalse((self.root/'execution-receipts').exists())

    def test_interrupted_intent_never_repeats_external_work(self):
        with patch.object(m, 'execute_checkpoint', side_effect=RuntimeError('connection lost')) as execute:
            with self.assertRaises(RuntimeError):
                m.execute_bound(self.request, dict(self.binding))
            for operation in ('execute', 'reconcile'):
                with self.assertRaisesRegex(ValueError, 'OUTCOME_UNCERTAIN'):
                    m.execute_bound(dict(self.request, operation=operation), dict(self.binding))
            execute.assert_called_once()

    def test_receipt_cannot_be_reused_for_another_release(self):
        with patch.object(m, 'execute_checkpoint') as execute:
            m.execute_bound(self.request, dict(self.binding))
            changed = dict(self.job, artifactDigest='sha256:'+'c'*64)
            with self.assertRaisesRegex(ValueError, 'IDENTITY_CHANGED'):
                m.execute_bound(dict(self.request, job=changed), dict(self.binding, artifactDigest=changed['artifactDigest']))
            execute.assert_called_once()

    def test_expired_lease_and_old_protocol_cannot_mutate(self):
        with patch.object(m, 'execute_checkpoint') as execute:
            with self.assertRaisesRegex(ValueError, 'LEASE_EXPIRED'):
                m.execute_bound(self.request, dict(self.binding, expiresAt=time.time()-1))
            with self.assertRaisesRegex(ValueError, 'INVALID_REQUEST'):
                m.execute_bound(dict(self.request, schemaVersion=1), self.binding)
            execute.assert_not_called()

    def test_capacity_blocker_does_not_leave_uncertain_intent(self):
        job = dict(self.job, step='ALLOCATE')
        request = dict(self.request, job=job, idempotencyKey=job['id']+':ALLOCATE')
        with patch.object(m, 'check_capacity', side_effect=m.Blocked('CAPACITY_REQUIRED')):
            with self.assertRaises(m.Blocked): m.execute_bound(request, self.binding)
        self.assertFalse((self.root/'execution-receipts').exists())
        with patch.object(m, 'check_capacity'), patch.object(m, 'execute_checkpoint') as execute:
            m.execute_bound(request, self.binding)
            execute.assert_called_once()

    def test_each_deployment_checkpoint_runs_only_its_work(self):
        for step in ('DATABASE', 'MIGRATE', 'SERVICES', 'BOOTSTRAP', 'INGRESS'):
            job = dict(self.job, step=step)
            with self.subTest(step=step), patch.object(m, 'read_json', return_value={}), patch.object(m, 'render_compose', return_value={}), patch.object(m, 'compose') as compose, patch.object(m, 'migrate_runtime') as migrate, patch.object(m, 'bootstrap') as bootstrap, patch.object(m, 'verify_admin_and_theme'), patch.object(m, 'check_isolation'), patch.object(m, 'nginx_config', return_value='fixture'), patch.object(m, 'command') as command, patch.object(m.Path, 'exists', return_value=True), patch.object(m.Path, 'read_text', return_value='fixture'):
                m.execute_checkpoint(job, self.binding, self.root, self.root, self.inventory)
                self.assertEqual(compose.call_count, int(step in ('DATABASE', 'SERVICES')))
                self.assertEqual(migrate.call_count, int(step == 'MIGRATE'))
                self.assertEqual(bootstrap.call_count, int(step == 'BOOTSTRAP'))
                self.assertEqual(command.call_count, 2 if step == 'INGRESS' else 0)

    def test_deadline_bounds_all_commands_and_resets_between_checkpoints(self):
        with m.execution_window(dict(self.binding, expiresAt=time.time()+40)):
            self.assertLessEqual(m.bounded_timeout(95), 30)
            with patch.object(m.time, 'monotonic', return_value=m.DEADLINE.get()+1):
                with self.assertRaises(TimeoutError): m.bounded_timeout(1)
        self.assertEqual(m.bounded_timeout(95), 95)

    def test_timeout_kills_command_descendants_before_they_can_write(self):
        marker = self.root / 'orphan-wrote'
        script = "import os,time,pathlib; child=os.fork(); time.sleep(0.6 if child == 0 else 10); pathlib.Path(" + repr(str(marker)) + ").write_text('unexpected')"
        with self.assertRaises(subprocess.TimeoutExpired):
            m.command([sys.executable, '-c', script], timeout=0.1)
        time.sleep(0.7)
        self.assertFalse(marker.exists())

if __name__ == '__main__':
    unittest.main()
