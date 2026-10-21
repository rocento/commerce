"""Fail closed on unreviewed Rust crate edges; inspect every Cargo target/kind."""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

import argparse
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[3]
LAYERS = {'composition', 'domain', 'adapter', 'infrastructure', 'contracts'}
TRANSPORT = {'axum', 'actix-web', 'warp', 'hyper', 'reqwest', 'tonic', 'async-nats'}
CONTRACT_RUNTIME = TRANSPORT | {'sqlx', 'tokio', 'diesel', 'rusqlite'}


def violations(metadata, policy):
    errors = []
    if policy.get('version') != 1:
        return ['unsupported architecture policy version']
    rules = policy['crates']
    members = set(metadata['workspace_members'])
    packages = {p['name']: p for p in metadata['packages'] if p['id'] in members}
    for name in sorted(set(packages) ^ set(rules)):
        errors.append(f'{name}: workspace and policy membership differ; classify new crates explicitly')
    graph = {name: set() for name in packages}
    for name, package in packages.items():
        if name not in rules:
            continue
        rule = rules[name]
        layer = rule['layer']
        if layer not in LAYERS:
            errors.append(f'{name}: invalid layer {layer}')
        allowed = set(rule['allowed_internal'])
        for target in allowed - set(packages):
            errors.append(f'{name}: policy names missing crate {target}')
        actual = set()
        for dep in package['dependencies']:
            # Cargo gives the package name even for renamed, inherited, optional,
            # build/dev and target-specific dependencies. Do not filter by host cfg.
            target = dep['name']
            context = f'{name} -> {target} ({dep.get("kind") or "normal"}, {dep.get("target") or "all targets"})'
            if dep.get('path') or target in packages:
                if target not in packages or not dep.get('path') or Path(dep['path']).resolve() != Path(packages[target]['manifest_path']).resolve().parent:
                    errors.append(f'{context}: local dependency must be a classified workspace member at its declared path')
                    continue
                actual.add(target)
                graph[name].add(target)
                if target not in allowed:
                    errors.append(f'{context}: prohibited dependency; review ownership before updating policy')
                target_layer = rules.get(target, {}).get('layer')
                if layer != 'composition' and target_layer == 'composition':
                    errors.append(f'{context}: only composition may depend on composition')
                if layer in {'contracts', 'infrastructure'} and target_layer in {'domain', 'adapter', 'composition'}:
                    errors.append(f'{context}: lower layers cannot depend on application/domain layers')
                if layer == 'contracts' and target_layer != 'contracts':
                    errors.append(f'{context}: contracts must remain independent of runtime infrastructure')
            if layer == 'domain' and target in TRANSPORT:
                errors.append(f'{context}: transport belongs in composition or an explicit adapter')
            if layer == 'contracts' and target in CONTRACT_RUNTIME:
                errors.append(f'{context}: contracts cannot own database, transport or runtime execution')
        for target in allowed - actual:
            errors.append(f'{name} -> {target}: stale allowance; remove unused permission')
    visiting, visited = set(), set()

    def walk(name, trail):
        if name in visiting:
            errors.append('dependency cycle: ' + ' -> '.join(trail + [name]))
            return
        if name in visited:
            return
        visiting.add(name)
        for target in sorted(graph[name]):
            walk(target, trail + [name])
        visiting.remove(name)
        visited.add(name)

    for name in sorted(graph):
        walk(name, [])
    return sorted(set(errors))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest-path', type=Path, default=ROOT / 'commerce-api/rocento-api/Cargo.toml')
    parser.add_argument('--policy', type=Path, default=ROOT / 'commerce-api/rocento-api/architecture-policy.json')
    args = parser.parse_args()
    try:
        result = subprocess.run(['cargo', 'metadata', '--offline', '--no-deps', '--format-version', '1',
                                 '--manifest-path', str(args.manifest_path)], check=True, capture_output=True, text=True)
        metadata = json.loads(result.stdout)
        errors = violations(metadata, json.loads(args.policy.read_text()))
    except (OSError, ValueError, KeyError, TypeError, subprocess.CalledProcessError) as error:
        print(f'Rust architecture check could not complete: {error}')
        return 1
    if errors:
        print('\n'.join(errors))
        return 1
    print(f'Rust architecture: {len(metadata["workspace_members"])} classified crates; dependency and layer checks passed')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
