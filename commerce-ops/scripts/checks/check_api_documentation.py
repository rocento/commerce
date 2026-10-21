"""Fail closed when gateway routes, reviewed audiences and API references diverge.

The checked-in policy is an exact method/path review, never a prefix rule. This
source scan deliberately rejects router syntax it cannot account for. It is a
coverage guard, not a proof of runtime authorization or deployment availability.
"""
from __future__ import annotations

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))


import argparse
from collections import Counter
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[3]
POLICY = ROOT / 'commerce-ops/scripts/checks/api_documentation_policy.json'
INVENTORY = ROOT / 'commerce-api/api-documentation-inventory.json'
METHODS = {'get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'}


def tokens(source):
    """Lex the small Rust surface needed to find registrations, ignoring comments."""
    result = []
    index = 0
    while index < len(source):
        if source[index].isspace():
            index += 1
        elif source.startswith('//', index):
            end = source.find('\n', index)
            index = len(source) if end < 0 else end
        elif source.startswith('/*', index):
            depth = 1
            index += 2
            while depth and index < len(source):
                if source.startswith('/*', index):
                    depth += 1
                    index += 2
                elif source.startswith('*/', index):
                    depth -= 1
                    index += 2
                else:
                    index += 1
            if depth:
                raise ValueError('Unclosed Rust comment')
        elif match := re.match(r'(?:b?r)(#*)"', source[index:]):
            end_marker = '"' + match[1]
            start = index + match.end()
            end = source.find(end_marker, start)
            if end < 0:
                raise ValueError('Unclosed Rust raw string')
            result.append(('string', source[start:end]))
            index = end + len(end_marker)
        elif match := re.match(r"'(?:\\u\{[0-9A-Fa-f_]+\}|\\.|[^\\'])'", source[index:]):
            result.append(('character', match[0]))
            index += match.end()
        elif source[index] == '"':
            end = index + 1
            while end < len(source):
                if source[end] == '\\':
                    end += 2
                elif source[end] == '"':
                    end += 1
                    break
                else:
                    end += 1
            try:
                value = json.loads(source[index:end])
            except (ValueError, json.JSONDecodeError):
                # Rust-only escapes in non-route strings are irrelevant. If
                # used as a route literal, the leading slash check rejects it.
                value = '<unsupported-string>'
            result.append(('string', value))
            index = end
        elif match := re.match(r'[A-Za-z_][A-Za-z_0-9]*', source[index:]):
            result.append(('word', match[0]))
            index += match.end()
        else:
            result.append(('punctuation', source[index]))
            index += 1
    return result


def arguments(stream, opening):
    pairs = {'(': ')', '[': ']', '{': '}'}
    stack = [')']
    parts = [[]]
    index = opening + 1
    while index < len(stream):
        token = stream[index]
        kind, value = token
        if kind == 'punctuation':
            if value in pairs:
                stack.append(pairs[value])
            elif value in pairs.values():
                if not stack or value != stack.pop():
                    raise ValueError('Unbalanced route expression')
                if not stack:
                    return parts
            elif value == ',' and len(stack) == 1:
                parts.append([])
                index += 1
                continue
        parts[-1].append(token)
        index += 1
    raise ValueError('Unclosed route expression')


def production_tokens(source):
    """Omit only explicit #[cfg(test)] items, retaining other cfg-gated routes.

    Test fixtures may construct routers for paths that are never registered by
    the gateway. Token boundaries keep braces in strings/comments harmless.
    """
    stream = tokens(source)
    marker = tokens('#[cfg(test)]')
    output = []
    index = 0
    while index < len(stream):
        if stream[index:index + len(marker)] != marker:
            output.append(stream[index])
            index += 1
            continue
        index += len(marker)
        # The next item ends at its top-level semicolon or closing block.
        pairs = {'(': ')', '[': ']', '{': '}'}
        stack = []
        while index < len(stream):
            kind, value = stream[index]
            index += 1
            if kind != 'punctuation':
                continue
            if value in pairs:
                stack.append(pairs[value])
            elif value in pairs.values():
                if not stack or value != stack.pop():
                    raise ValueError('Unbalanced cfg(test) item')
                if not stack and value == '}':
                    break
            elif value == ';' and not stack:
                break
        else:
            raise ValueError('Unclosed cfg(test) item')
    return output


def scan_source(source, filename):
    stream = production_tokens(source)
    literals = {}
    for index, token in enumerate(stream):
        if token != ('word', 'const') or index + 1 >= len(stream):
            continue
        end = index + 2
        while end < len(stream) and stream[end] not in [('punctuation', '='), ('punctuation', ';')]:
            end += 1
        if end + 2 < len(stream) and stream[end] == ('punctuation', '=') and stream[end + 1][0] == 'string' and stream[end + 2] == ('punctuation', ';'):
            name, value = stream[index + 1][1], stream[end + 1][1]
            if name in literals and literals[name] != value:
                raise ValueError(f'{filename}: ambiguous route constant {name}')
            literals[name] = value
    operations = set()
    fallbacks = set()
    for index in range(len(stream) - 2):
        if stream[index] != ('punctuation', '.') or stream[index + 2] != ('punctuation', '('):
            continue
        name = stream[index + 1][1]
        if name in {'nest', 'nest_service', 'route_service', 'fallback_service'}:
            raise ValueError(f'{filename}: unsupported {name}; extend the coverage scanner before adding this router')
        if name not in {'route', 'fallback'}:
            continue
        args = arguments(stream, index + 2)
        # This admission-policy lookup shares the method name but does not
        # register an Axum route. Keep the exception exact and source-local.
        if (filename == 'commerce-api/rocento-api/crates/api-gateway/src/identity.rs'
                and stream[max(0, index - 3):index] == [('word', 'app'), ('punctuation', '.'), ('word', 'public_admission')]
                and args == [tokens('request.uri().path()'), tokens('request.method()')]):
            continue
        if name == 'fallback':
            if len(args) != 1 or len(args[0]) != 1 or args[0][0][0] != 'word':
                raise ValueError(f'{filename}: unsupported fallback expression')
            fallbacks.add(f'{filename}:fallback({args[0][0][1]})')
            continue
        if len(args) not in {2, 3} or (len(args) == 3 and args[2]) or len(args[0]) != 1:
            raise ValueError(f'{filename}: route path must be an explicitly reviewed literal')
        kind, value = args[0][0]
        path = value if kind == 'string' else literals.get(value, '')
        if not path.startswith('/'):
            raise ValueError(f'{filename}: unsupported route path literal')
        depth = 0
        methods = set()
        expression = args[1]
        for offset, (kind, value) in enumerate(expression):
            if kind == 'word' and depth == 0 and expression[offset + 1:offset + 2] == [('punctuation', '(')]:
                if value in METHODS:
                    methods.add(value)
                elif value not in {'layer', 'route_layer', 'with_state'}:
                    raise ValueError(f'{filename}: unsupported method router {value} for {path}')
            if kind == 'punctuation':
                if value in {'(', '[', '{'}:
                    depth += 1
                elif value in {')', ']', '}'}:
                    depth -= 1
        if not methods:
            raise ValueError(f'{filename}: unsupported methods for {path}')
        operations.update((path, method) for method in methods)
    return operations, fallbacks


def scan_gateway(directory, root=ROOT):
    routes = {}
    fallbacks = set()
    for file in sorted(directory.rglob('*.rs')):
        filename = str(file.relative_to(root))
        operations, discovered_fallbacks = scan_source(file.read_text(), filename)
        for operation in operations:
            routes.setdefault(operation, []).append(filename)
        fallbacks.update(discovered_fallbacks)
    return routes, fallbacks


def contract_operations(contract):
    return {(path, method) for path, values in contract['paths'].items() for method in values if method in METHODS}


def label(operation):
    return f'{operation[1].upper()} {operation[0]}'


def load_policy(policy):
    if policy.get('version') != 1:
        raise ValueError('Unknown API documentation policy version')
    reviewed = {}
    for group in policy['groups']:
        if not group.get('reason') or not group.get('audience'):
            raise ValueError('Every reviewed group requires an audience and reason')
        surfaces = group.get('references', [])
        if not set(surfaces) <= {'public', 'merchant', 'internal'}:
            raise ValueError('Unknown documentation reference')
        if not group.get('full_contract', True) and not group.get('exemption'):
            raise ValueError('Every OpenAPI exemption requires an explanation')
        for route in group['operations']:
            method, separator, path = route.partition(' ')
            if not separator or method.lower() not in METHODS or method != method.upper() or not path.startswith('/'):
                raise ValueError(f'Invalid reviewed operation: {route}')
            operation = (path, method.lower())
            if operation in reviewed:
                raise ValueError(f'Duplicate reviewed operation: {route}')
            reviewed[operation] = group
    return reviewed


def inventory(routes, fallbacks, policy, full, public, merchant):
    reviewed = load_policy(policy)
    route_set = set(routes)
    if route_set != set(reviewed):
        unknown = sorted(label(op) for op in route_set - set(reviewed))
        obsolete = sorted(label(op) for op in set(reviewed) - route_set)
        raise ValueError(f'Gateway audience review required; unclassified={unknown}; obsolete={obsolete}')
    if fallbacks != set(policy['fallbacks']):
        raise ValueError('Renderer fallbacks changed; explicit coverage review required')
    expected_full = {op for op, group in reviewed.items() if group.get('full_contract', True)}
    for name, actual, expected in [
        ('full', contract_operations(full), expected_full),
        ('public', contract_operations(public), {op for op, group in reviewed.items() if 'public' in group['references']}),
        ('merchant', contract_operations(merchant), {op for op, group in reviewed.items() if 'merchant' in group['references']}),
    ]:
        if actual != expected:
            missing = sorted(label(op) for op in expected - actual)
            unexpected = sorted(label(op) for op in actual - expected)
            raise ValueError(f'{name} reference disagrees with reviewed inventory; missing={missing}; unexpected={unexpected}')
    operations = []
    for op in sorted(routes):
        group = reviewed[op]
        entry = {
            'method': op[1].upper(), 'path': op[0], 'sources': routes[op],
            'audience': group['audience'], 'references': group['references'],
            'full_contract': group.get('full_contract', True), 'reason': group['reason'],
        }
        if 'exemption' in group:
            entry['exemption'] = group['exemption']
        operations.append(entry)
    return {
        'version': 1,
        'scope': 'Explicit gateway registrations, including optional feature routers. GET also supports Axum implicit HEAD; generated HEAD is not a separate declared operation. Source coverage does not establish runtime authorization or deployment availability.',
        'counts': {
            'registered_operations': len(routes), 'full_contract_operations': len(expected_full),
            'public_operations': len(contract_operations(public)), 'merchant_operations': len(contract_operations(merchant)),
            'audiences': dict(sorted(Counter(group['audience'] for group in reviewed.values()).items())),
        },
        'operations': operations,
        'fallbacks': policy['fallbacks'],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--write', action='store_true', help='Refresh the private generated inventory only after all checks pass')
    mode.add_argument('--check', action='store_true', help='Verify the private inventory is current (default)')
    args = parser.parse_args()
    routes, fallbacks = scan_gateway(ROOT / 'commerce-api/rocento-api/crates/api-gateway/src')
    read = lambda path: json.loads(path.read_text())
    result = inventory(routes, fallbacks, read(POLICY), read(ROOT / 'commerce-api/rocento-api/openapi.json'), read(ROOT / 'commerce-corporate-site/public/docs/api/openapi.json'), read(ROOT / 'commerce-api/rocento-api/merchant-openapi.json'))
    rendered = json.dumps(result, indent=2) + '\n'
    if args.write:
        INVENTORY.write_text(rendered)
    elif not INVENTORY.exists() or INVENTORY.read_text() != rendered:
        raise SystemExit('Private API inventory is stale. Review changes, then run python3 commerce-ops/scripts/checks/check_api_documentation.py --write.')
    print(json.dumps(result['counts'], sort_keys=True))


if __name__ == '__main__':
    main()
