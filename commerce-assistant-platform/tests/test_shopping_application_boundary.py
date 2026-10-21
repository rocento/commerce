"""Shopping domain imports stay independent of application presentation."""

import subprocess
import sys

import pytest


@pytest.mark.parametrize(
    "module",
    [
        "app.commerce_action_engine.actions.shopping",
        "app.commerce_action_engine.actions.shopping.contracts",
        "app.commerce_action_engine.actions.shopping.selection",
        "app.commerce_action_engine.actions.shopping.baskets",
    ],
)
def test_domain_imports_do_not_load_shopping_application(module):
    subprocess.run(
        [
            sys.executable,
            "-c",
            (
                f"import importlib, sys; importlib.import_module({module!r}); "
                "assert 'app.commerce_action_engine.application.shopping' not in sys.modules; "
                "assert 'app.commerce_action_engine.application.shopping_presentation' not in sys.modules"
            ),
        ],
        check=True,
    )


def test_registry_points_to_application_orchestrator():
    from app.commerce_action_engine.actions.registry import default_registry

    assert any(
        action.implementation
        == "app.commerce_action_engine.application.shopping:shopping_answer"
        for action in default_registry().all()
    )
