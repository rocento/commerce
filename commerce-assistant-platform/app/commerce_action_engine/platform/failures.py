"""Customer-safe failures. Never use exception text or provider response bodies."""

from uuid import UUID

from app.commerce_action_engine.contracts import AssistantFailure
from app.commerce_action_engine.shared.errors import RuntimeErrorCode, ToolUnavailable
from app.commerce_resolution_engine.contracts import ModelError


def failure(code: str, reference: UUID) -> AssistantFailure:
    # One fixed message and recovery action for each public failure category.
    cases = {
        "provider_timeout": (
            "The assistant took too long to respond. Please retry.",
            True,
            "retry",
        ),
        "provider_rate_limit": (
            "The assistant is busy. Please wait a moment and retry.",
            True,
            "retry",
        ),
        "tool_unavailable": (
            "The requested store service is temporarily unavailable. Please retry.",
            True,
            "retry",
        ),
        "catalog_failure": (
            "Current product details could not be checked. You can browse the catalog.",
            True,
            "browse_catalog",
        ),
        "stale_proposal": (
            "This proposal is out of date. Refresh and review it before applying changes.",
            False,
            "refresh_proposal",
        ),
        "invalid_provider_response": (
            "The assistant could not verify its response. Please retry.",
            True,
            "retry",
        ),
        "authentication_needed": (
            "Please sign in again to continue.",
            False,
            "sign_in",
        ),
        "unsupported_action": (
            "The assistant cannot perform this action. Please contact support.",
            False,
            "contact_support",
        ),
        "internal_failure": (
            "The assistant could not complete this request. Please contact support with the reference below.",
            False,
            "contact_support",
        ),
    }
    if code not in cases:
        code = "internal_failure"
    message, retryable, recovery = cases[code]
    return AssistantFailure.model_validate(
        {
            "code": code,
            "message": message,
            "retryable": retryable,
            "recovery": recovery,
            "request_reference": reference,
        }
    )


def classify(error: Exception, reference: UUID) -> AssistantFailure:
    if isinstance(error, TimeoutError):
        return failure("provider_timeout", reference)
    if isinstance(error, ToolUnavailable):
        return failure("tool_unavailable", reference)
    code = (
        error.code if isinstance(error, (ModelError, RuntimeErrorCode)) else "unknown"
    )
    code = code.removeprefix("model_")
    public = {
        "timeout": "provider_timeout",
        "rate_limit": "provider_rate_limit",
        "tool_timeout": "tool_unavailable",
        "tool_unavailable": "catalog_failure",
        "invalid_response": "invalid_provider_response",
        "invalid_shopping_plan": "invalid_provider_response",
        "invalid_reference": "invalid_provider_response",
        "invalid_tool_call": "invalid_provider_response",
        "invalid_tool_arguments": "invalid_provider_response",
        "output_limit": "invalid_provider_response",
        "tool_not_allowed": "unsupported_action",
        "tool_forbidden": "unsupported_action",
        "refused": "unsupported_action",
        "stale_proposal": "stale_proposal",
        "login_required": "authentication_needed",
        "authentication_needed": "authentication_needed",
        "provider_rate_limit": "provider_rate_limit",
        "provider_timeout": "provider_timeout",
        "unsupported_action": "unsupported_action",
        # Provider authentication errors concern the merchant's key, not customer login.
        "authentication": "internal_failure",
        "configuration": "internal_failure",
        "unavailable": "tool_unavailable",
    }.get(code, "internal_failure")
    return failure(public, reference)
