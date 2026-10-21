"""Versioned linguistic action metadata. Never an execution or identity contract."""

from typing import Annotated, Any, Literal, Self

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    SerializerFunctionWrapHandler,
    model_serializer,
    model_validator,
)

ActionLabel = Annotated[str, Field(pattern=r"^request[1-9][0-9]{0,2}$", max_length=10)]
IntentCode = Annotated[str, Field(pattern=r"^[A-Z][A-Z0-9_]{0,79}$")]
BoundedText = Annotated[str, Field(min_length=1, max_length=4000)]
Count = Annotated[int, Field(strict=True, ge=0, le=32)]
Issue = Literal[
    "UNRESOLVED_REQUEST",
    "UNRESOLVED_PRODUCT",
    "INVALID_QUANTITY",
    "ALTERNATIVE_ACTIONS",
    "CONDITIONAL_REQUEST",
    "REQUEST_LIMIT",
    "INTERPRETATION_CONFLICT",
]


class RequestedItem(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")

    productText: BoundedText | None = None
    quantity: Annotated[int, Field(strict=True, ge=1, le=1_000_000)] | None = None
    unit: (
        Literal[
            "kg",
            "g",
            "l",
            "ml",
            "litre",
            "litres",
            "kilogram",
            "kilograms",
            "packs",
            "pack",
            "pieces",
            "piece",
        ]
        | None
    ) = None
    reference: BoundedText | None = None
    resolvedFrom: BoundedText | None = None
    selectionStrategy: IntentCode | None = None

    @model_validator(mode="after")
    def require_description_or_reference(self) -> Self:
        if not (self.productText and self.productText.strip()) and not self.reference:
            raise ValueError(
                "Requested item needs a description or linguistic reference"
            )
        return self


class RequestedAction(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")

    id: ActionLabel
    intent: IntentCode
    text: BoundedText
    items: list[RequestedItem] = Field(max_length=50)
    after: ActionLabel | None = None


class RequestedActionMetadata(BaseModel):
    """Mixin for the additive wire fields; absent fields mean a legacy response."""

    model_config = ConfigDict(strict=True)

    requestedActionsVersion: Annotated[int, Field(strict=True, ge=1, le=1)] | None = (
        None
    )
    intentCount: Count | None = None
    uniqueIntentCount: Count | None = None
    intentCountStatus: Literal["EXACT", "NEEDS_CLARIFICATION"] | None = None
    requestedActions: list[RequestedAction] | None = Field(default=None, max_length=32)
    requestedActionIssues: list[Issue] | None = Field(default=None, max_length=7)

    @model_validator(mode="after")
    def validate_requested_actions(self) -> Self:
        fields = {
            "requestedActionsVersion",
            "intentCount",
            "uniqueIntentCount",
            "intentCountStatus",
            "requestedActions",
            "requestedActionIssues",
        }
        present = fields & self.model_fields_set
        if not present:
            return self
        if present != fields or self.requestedActionsVersion != 1:
            raise ValueError("Incomplete or unsupported requested-action metadata")
        actions = self.requestedActions
        issues = self.requestedActionIssues
        if actions is None or issues is None or len(set(issues)) != len(issues):
            raise ValueError("Requested actions and unique issue codes are required")
        seen: set[str] = set()
        for action in actions:
            if action.id in seen:
                raise ValueError("Duplicate requested-action label")
            # Wire order is customer order: dependencies must refer backwards.
            # This also excludes self-dependencies and cycles.
            if action.after is not None and action.after not in seen:
                raise ValueError("Requested-action dependency must precede the action")
            seen.add(action.id)
        if self.intentCountStatus == "EXACT":
            if self.intentCount != len(actions) or self.uniqueIntentCount != len(
                {action.intent for action in actions}
            ):
                raise ValueError("Requested-action counts do not match the action list")
            if any(issue != "INTERPRETATION_CONFLICT" for issue in issues):
                raise ValueError(
                    "An exact count cannot include unresolved count issues"
                )
        elif self.intentCountStatus == "NEEDS_CLARIFICATION":
            if (
                self.intentCount is not None
                or self.uniqueIntentCount is not None
                or not issues
            ):
                raise ValueError(
                    "Uncertain actions require null counts and issue codes"
                )
        else:
            raise ValueError("Requested-action count status is required")
        return self

    @model_serializer(mode="wrap")
    def serialize_metadata(
        self, handler: SerializerFunctionWrapHandler
    ) -> dict[str, Any]:
        data: dict[str, Any] = handler(self)
        if self.requestedActionsVersion is None:
            for key in (
                "requestedActionsVersion",
                "intentCount",
                "uniqueIntentCount",
                "intentCountStatus",
                "requestedActions",
                "requestedActionIssues",
            ):
                data.pop(key, None)
        return data

    def requested_action_shadow(self) -> dict[str, object]:
        """Bounded, content-free diagnostics; no names, quantities or customer text."""
        if self.requestedActionsVersion is None:
            return {"metadata": "absent"}
        return {
            "metadata": "validated",
            "version": self.requestedActionsVersion,
            "count_status": self.intentCountStatus,
            "action_count": self.intentCount,
            "unique_intent_count": self.uniqueIntentCount,
            "candidate_count": len(self.requestedActions or []),
            "issues": list(self.requestedActionIssues or []),
        }
