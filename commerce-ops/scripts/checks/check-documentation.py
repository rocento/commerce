"""Check maintained Markdown, index coverage and portable evidence references."""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[3]
DOCUMENTATION_ROOTS = ('commerce-docs', 'commerce-ops/deploy', 'commerce-assets')
ADDITIONAL_GUIDES = (
    'commerce-ops/README.md',
    'commerce-ops/tasks/local-development.md',
    'commerce-ops/tasks/onboarding.md',
    'commerce-ops/tasks/rocento-platform-deployment.md',
    'commerce-ops/tasks/operations-recovery.md',
    'commerce-ops/onboarding/README.md',
    'commerce-api/README.md',
    'commerce-api/rocento-api/README.md',
    'commerce-web/apps/mobile-studio/README.md',
    'commerce-ops/compose/README.md',
    'commerce-mobile-apps/README.md',
    'commerce-mobile-apps/PERFORMANCE.md',
    'commerce-mobile-apps/react-native/README.md',
    'commerce-mobile-apps/apps_screens/README.md',
)
SOURCE_DOCUMENTS = (
    'commerce-api/rocento-api/AGENTS.md',
    'commerce-api/onboard-api/README.md',
    'commerce-web/AGENTS.md',
    'commerce-assistant-platform/AGENTS.md',
    'commerce-ops/AGENTS.md',
    'commerce-ops/scripts/AGENTS.md',
    'commerce-ops/deploy/AGENTS.md',
    'commerce-assistant-platform/app/commerce_language_engine/data/knowledge/SOURCES.md',
    'commerce-corporate-site/AGENTS.md',
    'commerce-corporate-site/CLAUDE.md',
    'commerce-corporate-site/public/docs/fonts/LICENSE.md',
    'commerce-web/apps/rengine/public/fonts/LICENSE.md',
    'commerce-mobile-apps/AGENTS.md',
    'commerce-mobile-apps/android/CODING_STANDARDS.md',
    'commerce-mobile-apps/android/SIGNING_AND_KEYSTORE.md',
    'commerce-mobile-apps/ios/CODING_STANDARDS.md',
    'commerce-mobile-apps/ios/SIGNING_AND_KEYCHAIN.md',
)
LOCAL_EVIDENCE_ROOTS = {'commerce-output', 'commerce-artifacts', 'output', 'artifacts', '.local', 'tmp'}
EVIDENCE_MANIFEST = 'commerce-docs/platform/evidence/local-evidence.json'
REDIRECT_MARKER = '<!-- documentation-redirect -->'
# Inline links/images and reference definitions; optional titles are not paths.
DESTINATION = r'(?:<([^>\n]+)>|([^\s<>]+?))'
INLINE_LINK = re.compile(r'\]\(\s*' + DESTINATION + r'(?:\s+["\'][^\n]*?["\'])?\s*\)')
REFERENCE_LINK = re.compile(r'^\s{0,3}\[[^\]\n]+\]:\s*' + DESTINATION + r'(?:\s+.*)?$', re.MULTILINE)


def prose_lines(source: str) -> list[tuple[int, str]]:
    """Return numbered lines outside fenced code blocks."""
    lines = []
    fence = None
    for number, line in enumerate(source.splitlines(), 1):
        marker = re.match(r'^\s{0,3}(`{3,}|~{3,})', line)
        if fence:
            if marker and marker[1][0] == fence[0] and len(marker[1]) >= len(fence) and not line[marker.end():].strip():
                fence = None
            continue
        if marker:
            fence = marker[1]
            continue
        lines.append((number, line))
    return lines


def markdown_destinations(source: str) -> list[str]:
    """Ignore fenced examples and inline code before inspecting Markdown links."""
    source = re.sub(r'(`+).*?\1', '', '\n'.join(line for _, line in prose_lines(source)))
    return [match[1] or match[2] for pattern in (INLINE_LINK, REFERENCE_LINK) for match in pattern.finditer(source)]


def parsed_destination(raw: str):
    """Keep Markdown file:line links relative even when urlsplit sees a scheme."""
    parsed = urlsplit(raw)
    if (parsed.scheme.lower().endswith(('.md', '.mdx'))
            and re.fullmatch(r'\d+', parsed.path or '') and not parsed.netloc):
        return parsed._replace(scheme='', path=f'{parsed.scheme}:{parsed.path}')
    return parsed


def documentation_paths(root: Path) -> list[Path]:
    paths = [root / 'README.md', *(path for directory in DOCUMENTATION_ROOTS for path in sorted((root / directory).rglob('*.md')))]
    paths.extend(root / name for name in (*ADDITIONAL_GUIDES, *SOURCE_DOCUMENTS) if (root / name).is_file())
    return list(dict.fromkeys(path for path in paths if path.is_file() and not path.is_symlink()))


def markdown_anchors(source: str) -> set[str]:
    """Recognize GitHub-style ATX heading IDs and explicit HTML anchors."""
    anchors = set()
    heading_ids = set()
    for _, line in prose_lines(source):
        anchors.update(re.findall(r'\b(?:id|name)=["\']([^"\']+)["\']', line))
        heading = re.match(r'^\s{0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$', line)
        if not heading:
            continue
        label = re.sub(r'!?\[([^\]]+)\]\([^)]*\)', r'\1', heading[1])
        label = re.sub(r'<[^>]+>', '', label).lower()
        slug = re.sub(r'[^\w\- ]', '', label).replace(' ', '-')
        candidate = slug
        suffix = 0
        while candidate in heading_ids:
            suffix += 1
            candidate = f'{slug}-{suffix}'
        heading_ids.add(candidate)
        anchors.add(candidate)
    return anchors


def structure_errors(source: str) -> list[str]:
    """Apply a small shared convention to authored guides, not legal text."""
    errors = []
    headings = []
    for number, line in prose_lines(source):
        heading = re.match(r'^\s{0,3}(#{1,6})\s+', line)
        if heading:
            level = len(heading[1])
            if headings and level > headings[-1] + 1:
                errors.append(f'{number}: heading skips a level')
            headings.append(level)
        trailing = line[len(line.rstrip()):]
        if trailing and (trailing != '  ' or not line.strip()):
            errors.append(f'{number}: trailing whitespace')
    if not headings or headings[0] != 1 or headings.count(1) != 1:
        errors.append('expected one level-one title before other headings')
    fence = None
    for number, line in enumerate(source.splitlines(), 1):
        marker = re.match(r'^\s{0,3}(`{3,}|~{3,})(.*)$', line)
        if not marker:
            continue
        if fence:
            if marker[1][0] == fence[0] and len(marker[1]) >= len(fence) and not marker[2].strip():
                fence = None
        else:
            fence = marker[1]
            if not marker[2].strip():
                errors.append(f'{number}: code fence needs a language')
    if fence:
        errors.append('unclosed code fence')
    if not source.endswith('\n') or source.endswith('\n\n'):
        errors.append('expected exactly one final newline')
    return errors


def check(root: Path) -> tuple[int, int, list[str]]:
    paths = documentation_paths(root)
    errors = []
    count = 0
    anchors = {}
    for path in paths:
        for raw in markdown_destinations(path.read_text()):
            parsed = parsed_destination(raw)
            if parsed.scheme or parsed.netloc or not (parsed.path or parsed.fragment):
                continue
            destination = re.sub(r':\d+$', '', unquote(parsed.path))
            count += 1
            lexical_target = Path(os.path.abspath(path.parent / destination)) if destination else path.absolute()
            target = lexical_target.resolve()
            relative_target = lexical_target.relative_to(root.absolute()) if lexical_target.is_relative_to(root.absolute()) else None
            if relative_target and relative_target.parts and relative_target.parts[0] in LOCAL_EVIDENCE_ROOTS:
                errors.append(f'{path.relative_to(root)}: local-only evidence link {raw}; link to the evidence catalog instead')
            elif Path(destination).is_absolute() or not target.is_relative_to(root.resolve()):
                errors.append(f'{path.relative_to(root)}: non-portable local link {raw}; use a relative repository destination')
            elif not target.exists():
                errors.append(f'{path.relative_to(root)}: {destination}')
            elif parsed.fragment and target.suffix.lower() in ('.md', '.mdx'):
                if target not in anchors:
                    anchors[target] = markdown_anchors(target.read_text())
                if unquote(parsed.fragment) not in anchors[target]:
                    errors.append(f'{path.relative_to(root)}: missing anchor {raw}')
    return len(paths), count, errors


def index_errors(root: Path) -> list[str]:
    """Require a direct link from the closest owning index, including sub-indexes."""
    directory = root / 'commerce-docs'
    errors = []
    for path in sorted(directory.rglob('*.md')):
        if path.is_symlink() or path == directory / 'README.md':
            continue
        source = path.read_text()
        if any(line.strip() == REDIRECT_MARKER for _, line in prose_lines(source)):
            # Redirects still undergo ordinary destination and anchor validation.
            if not markdown_destinations(source):
                errors.append(f'{path.relative_to(root)}: redirect needs a destination link')
            continue
        parent = path.parent.parent if path.name == 'README.md' else path.parent
        while parent.is_relative_to(directory) and not (parent / 'README.md').is_file():
            parent = parent.parent
        index = parent / 'README.md'
        if not parent.is_relative_to(directory) or not index.is_file():
            errors.append(f'{path.relative_to(root)}: no owning README.md index')
            continue
        destinations = set()
        for raw in markdown_destinations(index.read_text()):
            parsed = parsed_destination(raw)
            if not parsed.scheme and not parsed.netloc and parsed.path:
                destination = re.sub(r':\d+$', '', unquote(parsed.path))
                destinations.add((index.parent / destination).resolve())
        if path.resolve() not in destinations:
            errors.append(f'{path.relative_to(root)}: missing from owning index {index.relative_to(root)}')
    return errors


def evidence_errors(root: Path, *, local: bool = False) -> list[str]:
    """Validate catalog metadata without requiring ignored evidence in a checkout."""
    manifest = root / EVIDENCE_MANIFEST
    if not manifest.is_file():
        return []
    try:
        data = json.loads(manifest.read_text())
        if data.get('version') != 1 or not isinstance(data.get('entries'), list):
            return [f'{EVIDENCE_MANIFEST}: expected version 1 and entries list']
        errors = []
        seen = set()
        for entry in data['entries']:
            relative = entry.get('path', '')
            path = Path(relative)
            if (not relative or not path.parts or path.is_absolute() or '..' in path.parts
                    or path.parts[0] not in LOCAL_EVIDENCE_ROOTS or relative in seen):
                errors.append(f'{EVIDENCE_MANIFEST}: invalid or duplicate path {relative!r}')
                continue
            seen.add(relative)
            kind = entry.get('kind')
            if kind not in {'file', 'directory'} or entry.get('availability') not in {'local-only', 'archived', 'unavailable'}:
                errors.append(f'{EVIDENCE_MANIFEST}: invalid kind/availability for {relative}')
            if entry.get('availability') == 'archived' and not entry.get('archive_location'):
                errors.append(f'{EVIDENCE_MANIFEST}: archived evidence needs a location: {relative}')
            if entry.get('availability') == 'unavailable' and (not entry.get('removed_on') or entry.get('archive_location')):
                errors.append(f'{EVIDENCE_MANIFEST}: unavailable evidence needs a removal date and no archive location: {relative}')
            if kind == 'file' and (not isinstance(entry.get('bytes'), int) or entry['bytes'] < 0
                                  or not re.fullmatch(r'[a-f0-9]{64}', entry.get('sha256', ''))):
                errors.append(f'{EVIDENCE_MANIFEST}: invalid size/hash for {relative}')
            if not local or entry.get('availability') == 'unavailable':
                continue
            target = root / path
            if target.is_symlink() or not target.resolve().is_relative_to(root.resolve()):
                errors.append(f'{EVIDENCE_MANIFEST}: unsafe evidence path: {relative}')
            elif not target.exists():
                errors.append(f'{EVIDENCE_MANIFEST}: local evidence unavailable: {relative}')
            elif kind == 'file':
                if not target.is_file() or target.stat().st_size != entry.get('bytes') or hashlib.sha256(target.read_bytes()).hexdigest() != entry.get('sha256'):
                    errors.append(f'{EVIDENCE_MANIFEST}: local evidence changed: {relative}')
            elif not target.is_dir():
                errors.append(f'{EVIDENCE_MANIFEST}: expected directory: {relative}')
        return errors
    except (ValueError, TypeError, AttributeError) as error:
        return [f'{EVIDENCE_MANIFEST}: invalid manifest: {error}']


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check-local-evidence', action='store_true', help='also verify locally retained evidence sizes and hashes')
    args = parser.parse_args()
    documents, links, errors = check(ROOT)
    errors.extend(index_errors(ROOT))
    errors.extend(evidence_errors(ROOT, local=args.check_local_evidence))
    for path in documentation_paths(ROOT):
        # Source-adjacent instructions, licenses and provenance retain their formats.
        if path.relative_to(ROOT).as_posix() in SOURCE_DOCUMENTS:
            continue
        errors.extend(f'{path.relative_to(ROOT)}: {error}' for error in structure_errors(path.read_text()))
    if errors:
        raise SystemExit('Documentation errors:\n' + '\n'.join(errors))
    print(f'Checked {documents} Markdown documents and {links} local links: links, anchors, guide structure, indexes and evidence metadata pass.')


if __name__ == '__main__':
    main()
