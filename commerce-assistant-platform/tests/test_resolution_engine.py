"""The canonical LLM package imports independently of provider runtime."""

import pytest


def test_resolution_contracts_do_not_load_provider_runtime():
    import subprocess
    import sys

    subprocess.run(
        [
            sys.executable,
            "-c",
            (
                "import sys; import app.commerce_resolution_engine.contracts; "
                "assert 'app.commerce_resolution_engine.runtime' not in sys.modules; "
                "assert 'app.commerce_resolution_engine.providers' not in sys.modules"
            ),
        ],
        check=True,
    )


@pytest.mark.parametrize(
    "module", ["shopping", "basket", "runtime", "admission", "providers", "planning"]
)
def test_resolution_modules_import_independently(module):
    import subprocess
    import sys

    subprocess.run(
        [sys.executable, "-c", f"import app.commerce_resolution_engine.{module}"],
        check=True,
    )
