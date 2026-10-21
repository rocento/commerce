"""Regression coverage for the maintained-documentation link checker."""
import importlib.util
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('check_documentation', Path(__file__).resolve().parents[1] / 'check-documentation.py')
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


class DocumentationTests(unittest.TestCase):
    def test_inline_images_titles_and_reference_definitions(self):
        self.assertEqual(checker.markdown_destinations(
            '[guide](guide.md "Guide") ![image](image.png)\n'
            '[space](<my guide.md>)\n[ref]: guide.md "Title"\n'
        ), ['guide.md', 'image.png', 'my guide.md', 'guide.md'])

    def test_examples_are_not_links(self):
        self.assertEqual(checker.markdown_destinations(
            '```md\n[example](missing.md)\n```\n'
            '~~~~md\n[example](missing.md)\n~~~\n~~~~\n'
            '`[example](missing.md)`\n[real](exists.md)'
        ), ['exists.md'])

    def test_documentation_roots_and_missing_targets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'README.md').write_text('[guide](commerce-docs/guide.md)')
            for owner in checker.DOCUMENTATION_ROOTS:
                (root / owner).mkdir(parents=True, exist_ok=True)
                (root / owner / 'guide.md').write_text('[missing](missing.md)')
            (root / 'commerce-artifacts').mkdir()
            (root / 'commerce-artifacts/old.md').write_text('[historical](missing.md)')
            documents, links, errors = checker.check(root)
            self.assertEqual(documents, 1 + len(checker.DOCUMENTATION_ROOTS))
            self.assertEqual(links, documents)
            self.assertEqual(len(errors), len(checker.DOCUMENTATION_ROOTS))
            self.assertIn('commerce-ops/deploy/guide.md: missing.md', errors)

    def test_external_fragments_queries_and_encoded_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'my guide.md').write_text('# Guide\n\n## Setup\n')
            (root / 'README.md').write_text(
                '# Overview\n\n## Setup\n\n'
                '[web](https://example.test) [mail](mailto:test@example.test) '
                '[network](//example.test/guide) [anchor](#setup) '
                '[local](my%20guide.md?view=1#setup) [line](my%20guide.md:12)'
            )
            self.assertEqual(checker.check(root), (1, 3, []))

    def test_plain_markdown_file_line_is_relative(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'README.md').write_text('# Guide\n[Setup](setup.md:12)\n')
            (root / 'setup.md').write_text('# Setup\n')
            self.assertEqual(checker.check(root), (1, 1, []))

    def test_duplicate_formatted_unicode_and_explicit_anchors(self):
        self.assertEqual(checker.markdown_anchors(
            '# Guide\n## **Install** `tools`!\n## Setup\n## Setup\n'
            '## [Café](guide.md)\n<a id="custom"></a>\n'
            '```md\n## Example only\n```\n'
        ), {'guide', 'install-tools', 'setup', 'setup-1', 'café', 'custom'})

    def test_missing_local_and_cross_document_anchors(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'README.md').write_text(
                '# Guide\n[missing](#old-title) [other](other.md#gone) '
                '[valid](other.md#caf%C3%A9)\n'
            )
            (root / 'other.md').write_text('# Café\n')
            documents, links, errors = checker.check(root)
            self.assertEqual((documents, links), (1, 3))
            self.assertEqual(errors, [
                'README.md: missing anchor #old-title',
                'README.md: missing anchor other.md#gone',
            ])

    def test_source_adjacent_documents_are_checked_without_scanning_builds(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'README.md').write_text('# Guide\n')
            source_name = next(name for name in checker.SOURCE_DOCUMENTS if '/' in name)
            source = root / source_name
            source.parent.mkdir(parents=True)
            source.write_text('[missing](missing.md)')
            build = root / 'commerce-web/node_modules/package/README.md'
            build.parent.mkdir(parents=True)
            build.write_text('[ignored](missing.md)')
            documents, links, errors = checker.check(root)
            self.assertEqual((documents, links), (1, 1))
            self.assertEqual(errors, [f'{source_name}: missing.md'])

    def test_mobile_and_automation_guides_are_checked_without_native_build_trees(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in (*checker.ADDITIONAL_GUIDES, 'commerce-ops/deploy/aws-automation/README.md', 'commerce-mobile-apps/AGENTS.md'):
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('# Guide\n[missing](missing.md)\n')
            generated = root / 'commerce-mobile-apps/react-native/ios/Pods/README.md'
            generated.parent.mkdir(parents=True)
            generated.write_text('[ignored](missing.md)')
            documents, links, errors = checker.check(root)
            self.assertEqual(documents, len(checker.ADDITIONAL_GUIDES) + 2)
            self.assertEqual(links, documents)
            self.assertEqual(len(errors), documents)
            self.assertFalse(any('Pods' in error for error in errors))

    def test_root_and_scoped_source_docs_are_checked_once(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            names = ('commerce-api/rocento-api/AGENTS.md', 'commerce-api/onboard-api/README.md',
                     'commerce-web/AGENTS.md', 'commerce-assistant-platform/AGENTS.md',
                     'commerce-ops/scripts/AGENTS.md', 'commerce-ops/deploy/AGENTS.md')
            for name in names:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('# Agent guide\n[missing](missing.md)\n')
            generated = root / 'commerce-web/node_modules/example/AGENTS.md'
            generated.parent.mkdir(parents=True)
            generated.write_text('[ignored](missing.md)')
            documents, links, errors = checker.check(root)
            self.assertEqual((documents, links), (len(names), len(names)))
            self.assertCountEqual(errors, [f'{name}: missing.md' for name in names])

    def test_local_output_links_fail_even_when_target_exists(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'README.md').write_text('# Guide\n[evidence](commerce-output/run/report.json)\n')
            target = root / 'commerce-output/run/report.json'
            target.parent.mkdir(parents=True)
            target.write_text('{}')
            errors = checker.check(root)[2]
            self.assertEqual(len(errors), 1)
            self.assertIn('local-only evidence link', errors[0])
            target.unlink()
            self.assertEqual(checker.check(root)[2], errors)

    def test_symlinks_and_absolute_paths_cannot_hide_nonportable_links(self):
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory() as external:
            root = Path(directory)
            outside = Path(external) / 'report.md'
            outside.write_text('# Report\n')
            (root / 'commerce-output').mkdir()
            (root / 'commerce-output/report.md').symlink_to(outside)
            (root / 'reference.md').symlink_to(outside)
            (root / 'README.md').write_text(
                f'# Guide\n[evidence](commerce-output/report.md) [outside](reference.md) [absolute]({outside})\n'
            )
            errors = checker.check(root)[2]
            self.assertEqual(len(errors), 3)
            self.assertIn('local-only evidence link', errors[0])
            self.assertTrue(all('non-portable local link' in error for error in errors[1:]))

    def test_nearest_index_coverage_and_redirects(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            docs = root / 'commerce-docs'
            owner = docs / 'mobile'
            owner.mkdir(parents=True)
            (docs / 'README.md').write_text('# Docs\n[Mobile](mobile/README.md)\n')
            index = owner / 'README.md'
            index.write_text('# Mobile\n[Setup](setup.md:12)\n')
            (owner / 'setup.md').write_text('# Setup\n')
            (owner / 'orphan.md').write_text('# Missing\n')
            redirect = owner / 'old.md'
            redirect.write_text(f'# Moved\n{checker.REDIRECT_MARKER}\n[Setup](setup.md)\n')
            self.assertEqual(checker.index_errors(root), [
                'commerce-docs/mobile/orphan.md: missing from owning index commerce-docs/mobile/README.md',
            ])
            index.write_text(index.read_text() + '[Other](orphan.md)\n')
            self.assertEqual(checker.index_errors(root), [])
            redirect.write_text(f'# Moved\n{checker.REDIRECT_MARKER}\n')
            self.assertIn('redirect needs a destination', checker.index_errors(root)[0])

    def test_evidence_metadata_is_portable_and_local_verification_detects_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = root / checker.EVIDENCE_MANIFEST
            manifest.parent.mkdir(parents=True)
            payload = b'{"passed":true}\n'
            entry = {'path': 'commerce-output/run/report.json', 'kind': 'file', 'bytes': len(payload),
                     'sha256': hashlib.sha256(payload).hexdigest(), 'availability': 'local-only',
                     'archive_location': None}
            manifest.write_text(json.dumps({'version': 1, 'entries': [entry]}))
            self.assertEqual(checker.evidence_errors(root), [])
            self.assertIn('local evidence unavailable', checker.evidence_errors(root, local=True)[0])
            target = root / entry['path']
            target.parent.mkdir(parents=True)
            target.write_bytes(payload)
            self.assertEqual(checker.evidence_errors(root, local=True), [])
            target.write_text('{"passed":false}\n')
            self.assertIn('local evidence changed', checker.evidence_errors(root, local=True)[0])
            entry['path'] = 'commerce-output/../../escape.json'
            manifest.write_text(json.dumps({'version': 1, 'entries': [entry]}))
            self.assertIn('invalid or duplicate path', checker.evidence_errors(root)[0])
            entry['path'] = '.'
            manifest.write_text(json.dumps({'version': 1, 'entries': [entry]}))
            self.assertIn('invalid or duplicate path', checker.evidence_errors(root)[0])

    def test_archived_evidence_requires_retrieval_location(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = root / checker.EVIDENCE_MANIFEST
            manifest.parent.mkdir(parents=True)
            manifest.write_text(json.dumps({'version': 1, 'entries': [
                {'path': 'commerce-output/run', 'kind': 'directory', 'availability': 'archived'},
            ]}))
            self.assertIn('archived evidence needs a location', checker.evidence_errors(root)[0])

    def test_removed_evidence_keeps_metadata_without_claiming_local_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = root / checker.EVIDENCE_MANIFEST
            manifest.parent.mkdir(parents=True)
            entry = {'path': 'commerce-output/run/report.json', 'kind': 'file', 'bytes': 3,
                     'sha256': hashlib.sha256(b'old').hexdigest(),
                     'availability': 'unavailable', 'removed_on': '2026-10-14',
                     'archive_location': None}
            manifest.write_text(json.dumps({'version': 1, 'entries': [entry]}))
            self.assertEqual(checker.evidence_errors(root, local=True), [])
            del entry['removed_on']
            manifest.write_text(json.dumps({'version': 1, 'entries': [entry]}))
            self.assertIn('unavailable evidence needs a removal date', checker.evidence_errors(root)[0])

    def test_valid_structure_preserves_code_and_markdown_hard_breaks(self):
        self.assertEqual(checker.structure_errors(
            '# Guide\n\nPurpose.  \nContinued.\n\n## Setup\n\n'
            '```sh\n# a shell comment, not another title\necho ok  \n```\n'
            '\n### Details\n\n~~~~md\n```\n~~~~\n'
        ), [])

    def test_invalid_structure_is_reported(self):
        cases = (
            ('## Missing title\n', 'expected one level-one title before other headings'),
            ('# One\n# Two\n', 'expected one level-one title before other headings'),
            ('# Guide\n### Jump\n', '2: heading skips a level'),
            ('# Guide\ntext \n', '2: trailing whitespace'),
            ('# Guide\n```\ncode\n```\n', '2: code fence needs a language'),
            ('# Guide\n```sh\ncode\n', 'unclosed code fence'),
            ('# Guide', 'expected exactly one final newline'),
            ('# Guide\n\n', 'expected exactly one final newline'),
        )
        for source, error in cases:
            with self.subTest(source=source):
                self.assertIn(error, checker.structure_errors(source))


if __name__ == '__main__':
    unittest.main()
