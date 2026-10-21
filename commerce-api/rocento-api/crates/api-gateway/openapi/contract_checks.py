"""Standards normalization and full gateway route coverage (not public publication)."""
import re


# Infrastructure/discovery representations are not application JSON operations.
# Keep this exact list reviewable: new routes never inherit an exclusion by prefix.
ROUTE_EXCLUSIONS = {
    ('/health', 'get'): 'Process liveness; documented in commerce-docs/backend/api.md.',
    ('/metrics', 'get'): 'Private Prometheus exposition, not a JSON application API.',
    ('/robots.txt', 'get'): 'Robots Exclusion Protocol representation.',
    ('/sitemap.xml', 'get'): 'Sitemap index XML representation.',
    ('/sitemaps/{partition}', 'get'): 'Partitioned sitemap XML representation.',
    ('/llms.txt', 'get'): 'Public discovery text representation.',
}


def normalize_nullable(node):
    """OAS 3.0 Reference Objects ignore siblings; allOf cannot relax a ref's type.

    The second anyOf branch permits only null. It explicitly declares its type,
    as required by OAS 3.0 nullable, and its enum excludes every non-null object.
    This also works for referenced arrays and composed schemas without widening
    the non-null model or upgrading the API dialect used by existing clients.
    """
    if isinstance(node, list):
        return [normalize_nullable(value) for value in node]
    if not isinstance(node, dict):
        return node
    value = {key: normalize_nullable(item) for key, item in node.items()}
    # Draft-04/OAS 3.0 requires a nonempty required array and uses enum rather
    # than the newer JSON Schema const keyword imported by shopper tooling.
    if value.get('required') == []:
        value.pop('required')
    if 'const' in value:
        value['enum'] = [value.pop('const')]
    if value.get('nullable') and ('$ref' in value or 'type' not in value):
        value.pop('nullable')
        return {'anyOf': [value, {'type': 'object', 'nullable': True, 'enum': [None]}]}
    if value.get('nullable') and 'enum' in value and None not in value['enum']:
        value['enum'] = [*value['enum'], None]
    return value


def validate_paths(contract):
    for path, methods in contract['paths'].items():
        expected = set(re.findall(r'\{([^}]+)\}', path))
        for method, operation in methods.items():
            parameters = operation.get('parameters', [])
            actual = {p['name'] for p in parameters if p.get('in') == 'path' and p.get('required') is True}
            if expected != actual:
                raise ValueError(f'{method.upper()} {path}: path parameters {actual} != {expected}')
            identities = [(p['in'], p['name']) for p in parameters]
            if len(identities) != len(set(identities)):
                raise ValueError(f'{method.upper()} {path}: duplicate parameters')


def router_operations(source):
    """Share the audience policy's Rust scanner; do not maintain two parsers.

    The scanner rejects unreviewed router syntax and ignores Rust comments and
    the exact admission-policy lookup that shares Axum's route method name.
    """
    import importlib.util
    from pathlib import Path
    root = Path(__file__).resolve().parents[4]
    spec = importlib.util.spec_from_file_location('api_documentation_scanner', root / 'commerce-ops/scripts/checks/check_api_documentation.py')
    scanner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(scanner)
    operations = set()
    for file in source.rglob('*.rs'):
        if 'bin' in file.relative_to(source).parts:
            continue
        filename = str(file.relative_to(root)) if file.is_relative_to(root) else str(file.relative_to(source))
        registered, _fallbacks = scanner.scan_source(file.read_text(), filename)
        operations.update(registered)
    return operations


def validate_route_coverage(contract, source):
    runtime = router_operations(source)
    documented = {(path, method) for path, methods in contract['paths'].items() for method in methods}
    excluded = set(ROUTE_EXCLUSIONS)
    missing = runtime - documented - excluded
    stale = (documented | excluded) - runtime
    overlap = documented & excluded
    if missing or stale or overlap:
        raise ValueError(f'Route coverage: missing={sorted(missing)}, stale={sorted(stale)}, both documented/excluded={sorted(overlap)}')
