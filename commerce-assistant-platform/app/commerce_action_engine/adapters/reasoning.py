"""Action-registry capability checks around a model provider."""

from app.commerce_action_engine.contracts.action import (
    ModelRequirements,
    ProviderCapabilities,
)
from app.commerce_action_engine.execution.core.registry import (
    RegistryError,
    select_model,
)
from app.commerce_resolution_engine.adapter import ReasoningAdapter
from app.commerce_resolution_engine.contracts import (
    ModelError,
    ModelProvider,
    ModelRequest,
)


def reasoning_adapter(
    delegate: ModelProvider, capabilities: ProviderCapabilities
) -> ReasoningAdapter:
    """Bind registry policy without performing model operations in the action layer."""

    def check(request: ModelRequest, *, streaming: bool) -> None:
        try:
            select_model(
                (capabilities,),
                ModelRequirements(
                    structured_output=request.output_schema is not None,
                    tool_calling=bool(request.tools or request.tool_results),
                    streaming=streaming,
                    # Preserve existing character limits and provider admission.
                    # Bytes are not tokens: using a byte estimate here rejects
                    # otherwise valid large carts. Only assert the known output
                    # requirement; token accounting remains with the provider.
                    context_tokens=request.max_tokens,
                ),
                configured=frozenset({capabilities.profile}),
            )
        except RegistryError:
            raise ModelError("configuration") from None

    return ReasoningAdapter(delegate, check)
