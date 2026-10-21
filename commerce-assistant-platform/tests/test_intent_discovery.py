"""Authored retrieval examples stay compatible with guarded proposal acceptance."""

from test_enterprise_contracts import context as test_context
from test_language_fallback import resolved, unknown

from app.commerce_action_engine.execution.language.compatibility import (
    adapt_legacy_resolution,
)
from app.commerce_action_engine.execution.language.proposals import accepts_result
from app.commerce_contracts.language_proposal import LanguageProposal


def test_generic_meal_proposals_preserve_whole_current_request():
    context = test_context.__wrapped__()
    original = adapt_legacy_resolution(unknown().model_dump(), context)
    result = adapt_legacy_resolution(
        resolved(
            intent="PRODUCT_RECOMMEND",
            entities={"productText": "products", "catalogPurpose": "dinner"},
        ).model_dump(),
        context,
    )
    proposal = LanguageProposal(
        status="INTERPRETED",
        intent="PRODUCT_RECOMMEND",
        canonical_text="recommend products for dinner",
    )
    for text in ["I want dinner", "Need something for dinner", "Any ideas for dinner?"]:
        assert accepts_result(original, result, text, proposal), text
    for text in [
        "I want breakfast",
        "I want milk for dinner",
        "I want dinner under $12",
        "I want dinner without nuts",
        "I want dinner and add apple",
        "I do not want dinner",
    ]:
        assert not accepts_result(original, result, text, proposal), text


def test_discovery_evaluation_is_separate_and_passes():
    import json
    import subprocess
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    report = json.loads(
        subprocess.check_output(
            [
                "node",
                "app/commerce_language_engine/scripts/evaluate-intent-discovery.ts",
            ],
            cwd=root,
            text=True,
        )
    )
    assert report["status"] == "passed"
    assert report["canonical_examples"]["passed"] == 24
    assert report["held_out"]["passed"] == 10
    assert report["split_leakage"] == []
