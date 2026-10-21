"""Conservative static import audit. Dynamic imports and re-export bindings are excluded."""

import ast
import hashlib
import json
from importlib.util import resolve_name
from pathlib import Path

SERVICE = Path(__file__).resolve().parents[2]
ROOT = SERVICE / "app"
FILES = {
    ".".join(("app", *p.relative_to(ROOT).with_suffix("").parts)).removesuffix(
        ".__init__"
    ): p
    for p in ROOT.rglob("*.py")
    if "__pycache__" not in p.parts
}
EDGES = []

for module, path in sorted(FILES.items()):
    package = module if path.name == "__init__.py" else module.rsplit(".", 1)[0]

    class Imports(ast.NodeVisitor):
        def __init__(self, module, package):
            self.module = module
            self.package = package

        deferred = 0
        typing = 0

        def visit_FunctionDef(self, node):
            self.deferred += 1
            self.generic_visit(node)
            self.deferred -= 1

        visit_AsyncFunctionDef = visit_FunctionDef

        def visit_If(self, node):
            typed = (
                isinstance(node.test, ast.Name)
                and node.test.id == "TYPE_CHECKING"
                or isinstance(node.test, ast.Attribute)
                and node.test.attr == "TYPE_CHECKING"
            )
            if typed:
                self.typing += 1
                for child in node.body:
                    self.visit(child)
                self.typing -= 1
                for child in node.orelse:
                    self.visit(child)
            else:
                self.generic_visit(node)

        def edge(self, target, node):
            if target in FILES and not self.typing:
                EDGES.append(
                    {
                        "source": self.module,
                        "target": target,
                        "line": node.lineno,
                        "deferred": bool(self.deferred),
                    }
                )

        def visit_Import(self, node):
            for alias in node.names:
                self.edge(alias.name, node)

        def visit_ImportFrom(self, node):
            base = (
                resolve_name("." * node.level + (node.module or ""), self.package)
                if node.level
                else node.module or ""
            )
            self.edge(base, node)
            for alias in node.names:
                self.edge(base + "." + alias.name, node)

    Imports(module, package).visit(ast.parse(path.read_text()))


def components(edges):
    graph = {m: set() for m in FILES}
    for e in edges:
        graph[e["source"]].add(e["target"])
    index, low, stack, active, groups = {}, {}, [], set(), []

    def visit(v):
        index[v] = low[v] = len(index)
        stack.append(v)
        active.add(v)
        for w in graph[v]:
            if w not in index:
                visit(w)
                low[v] = min(low[v], low[w])
            elif w in active:
                low[v] = min(low[v], index[w])
        if low[v] == index[v]:
            group = []
            while True:
                w = stack.pop()
                active.remove(w)
                group.append(w)
                if w == v:
                    break
            if len(group) > 1:
                groups.append(sorted(group))

    for v in sorted(graph):
        if v not in index:
            visit(v)
    return sorted(groups, key=lambda x: (-len(x), x))


result = {
    "scope": "Python app files; syntactic module imports, excluding TYPE_CHECKING. Function-local imports are deferred. Does not resolve dynamic import strings, symbol re-exports, or implicit parent-package initialization; cycles are static candidates, not proof of runtime failure.",
    "modules": len(FILES),
    "edges": EDGES,
    "eager_cycle_candidates": components([e for e in EDGES if not e["deferred"]]),
    "all_cycle_candidates": components(EDGES),
    "source_sha256": {
        str(p.relative_to(SERVICE)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted(FILES.values())
    },
}
output = Path(__file__).with_name("import-audit.json")
output.write_text(json.dumps(result, indent=2) + "\n")
print(
    json.dumps(
        {k: v for k, v in result.items() if k not in {"edges", "source_sha256"}},
        indent=2,
    )
)
