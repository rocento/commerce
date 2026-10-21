"""Translate runtime events and publish scoped shopping continuation state.

The turn owns runtime iteration, event sequencing, final completion, transcript
persistence and resource cleanup. This coordinator processes one event at a time;
it neither advances nor closes the runtime stream.
"""

from dataclasses import dataclass
from typing import Literal
from uuid import UUID

from app.commerce_action_engine.actions.catalog.contracts import (
    CatalogProfile,
    CatalogSchema,
)
from app.commerce_action_engine.actions.shopping.continuation import active_shopping
from app.commerce_action_engine.actions.shopping.contracts import (
    ShoppingClarification,
    ShoppingIntent,
)
from app.commerce_action_engine.application.handlers.shopping_clarification import (
    shopping_question_view,
)
from app.commerce_action_engine.application.persistence import (
    ActiveShoppingWriter,
    ShoppingQuestionPublisher,
)
from app.commerce_action_engine.application.responses import validate_blocks
from app.commerce_action_engine.shared.errors import ToolUnavailable
from app.commerce_resolution_engine.runtime import RuntimeEvent


@dataclass(frozen=True)
class ShoppingResponseScope:
    tenant_id: UUID
    owner_id: UUID
    store_id: UUID
    session_id: UUID
    conversation_id: UUID | None
    request_revision: UUID | None
    message: str


@dataclass(frozen=True)
class RuntimeResponse:
    """Response fields for the turn's existing event factory; never a final event."""

    kind: Literal["progress", "content.blocks", "message.delta"]
    fields: dict[str, object]


class ShoppingRuntimeResponses:
    def __init__(
        self,
        *,
        scope: ShoppingResponseScope,
        active_writer: ActiveShoppingWriter | None,
        question_publisher: ShoppingQuestionPublisher | None,
        metadata: dict[str, object],
        model_provider: str,
    ):
        self.scope = scope
        self.active_writer = active_writer
        self.question_publisher = question_publisher
        self._metadata = metadata
        self.model_provider = model_provider
        self.length = 0
        self.tool_names: list[str] = []

    @property
    def metadata(self) -> dict[str, object]:
        """Borrow the turn-owned record without replacing it."""
        return self._metadata

    async def handle(self, event: RuntimeEvent) -> RuntimeResponse | None:
        """Retain partial metadata on errors; propagate failure and cancellation."""
        if event.type == "completed" and event.answer:
            if event.answer.completion_evidence:
                self.metadata["completion_evidence"] = event.answer.completion_evidence
            self.metadata.update(
                {
                    "model": event.answer.model[:100],
                    "provider": self.model_provider,
                    "input_tokens": event.answer.usage.input_tokens,
                    "output_tokens": event.answer.usage.output_tokens,
                    "tool_calls": event.answer.tool_calls,
                    "retrieval_count": len(event.answer.sources),
                }
            )
        if event.type == "tool_started":
            self.tool_names.append(event.text)
            self.metadata["tool_calls"] = len(self.tool_names)
            self.metadata["tools"] = list(dict.fromkeys(self.tool_names))
            return RuntimeResponse("progress", {"stage": "catalog"})
        if event.type == "tool_completed":
            return RuntimeResponse("progress", {"stage": "responding"})
        if event.type == "completed" and event.answer and event.answer.blocks:
            validate_blocks(event.answer.blocks)
            return RuntimeResponse(
                "content.blocks",
                {
                    "blocks": [
                        block.model_dump(mode="json", exclude_unset=True)
                        for block in event.answer.blocks
                    ]
                },
            )
        if event.type == "text_delta":
            return await self._text_response(event)
        return None

    async def _text_response(self, event: RuntimeEvent) -> RuntimeResponse:
        self.length += len(event.text)
        if self.length > 8000:
            raise ToolUnavailable()
        scope = self.scope
        fields: dict[str, object] = {}
        if (
            event.pending_shopping is None
            and event.shopping_frame is not None
            and event.shopping_revision
            and scope.request_revision is not None
            and scope.conversation_id
            and self.active_writer is not None
        ):
            active = active_shopping(
                ShoppingIntent.model_validate(event.shopping_frame.model_dump()),
                event.shopping_revision,
                CatalogProfile.model_validate(event.shopping_profile.model_dump())
                if event.shopping_profile
                else None,
                CatalogSchema.model_validate(event.shopping_schema.model_dump())
                if event.shopping_schema
                else None,
            )
            await self.active_writer.save_active_shopping(
                scope.tenant_id,
                scope.owner_id,
                scope.conversation_id,
                scope.request_revision,
                scope.message,
                active,
                store_id=scope.store_id,
                session_id=scope.session_id,
            )
        if event.pending_shopping is not None:
            pending_plan = ShoppingClarification.model_validate(
                event.pending_shopping.model_dump()
            )
            published = bool(
                self.question_publisher is not None
                and scope.conversation_id
                and scope.request_revision
                and await self.question_publisher.publish_shopping_question(
                    scope.tenant_id,
                    scope.owner_id,
                    scope.conversation_id,
                    scope.request_revision,
                    scope.message,
                    pending_plan,
                    store_id=scope.store_id,
                    session_id=scope.session_id,
                )
            )
            self.metadata["completion_disposition"] = "clarification"
            self.metadata["clarification_slot"] = pending_plan.field
            if published and scope.request_revision is not None:
                fields["clarification"] = shopping_question_view(
                    scope.message, scope.request_revision, pending_plan
                )
        elif event.clarification:
            self.metadata["completion_disposition"] = "clarification"
            self.metadata["clarification_slot"] = event.clarification
            fields["clarification"] = {
                "original_message": scope.message,
                "question": event.text,
            }
        return RuntimeResponse("message.delta", {"text": event.text, **fields})
