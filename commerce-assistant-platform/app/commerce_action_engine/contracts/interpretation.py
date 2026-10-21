"""Phase-0 interpretation contract. Meaning never grants execution authority."""

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, JsonValue, model_validator

from app.commerce_action_engine.contracts.action import Contract, Identifier
from app.commerce_action_engine.contracts.requested_actions import (
    RequestedActionMetadata,
)

Name = Annotated[str, Field(min_length=1, max_length=128)]
Text = Annotated[str, Field(max_length=4000)]
Fingerprint = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]


class SemanticValue(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True, allow_inf_nan=False)


class Clause(SemanticValue):
    id: Name
    text: Text
    start: int = Field(ge=0)
    end: int = Field(ge=0)
    intent: Name
    connector: str = Field(max_length=100)
    negated: bool

    @model_validator(mode="after")
    def ordered_span(self) -> "Clause":
        if self.end < self.start:
            raise ValueError("Clause end precedes start")
        return self


def validate_clause_spans(clauses: list[Clause], source: str) -> None:
    """Clause offsets address JavaScript UTF-16 units, independently of evidence."""
    encoded = source.encode("utf-16-le")
    for clause in clauses:
        if clause.end * 2 > len(encoded):
            raise ValueError("Clause span exceeds its source text")
        try:
            literal = encoded[clause.start * 2 : clause.end * 2].decode("utf-16-le")
        except UnicodeDecodeError as error:
            raise ValueError("Clause span splits a Unicode character") from error
        if literal != clause.text:
            raise ValueError("Clause text differs from its source span")


class Action(SemanticValue):
    id: Name
    intent: Name
    clauseId: Name
    operation: Name
    itemIndexes: list[Annotated[int, Field(ge=0, le=50)]] = Field(
        default_factory=list, max_length=51
    )


class ReferenceCandidate(SemanticValue):
    kind: Name
    value: Text
    industry: Name | None = None
    score: float = Field(ge=0, le=1)


class Reference(SemanticValue):
    """Linguistic bindings only, including references needing an authority lookup."""

    expression: Name
    kind: Literal["product", "order", "address", "result_set", "action"]
    resolved: bool
    target: str | None = Field(default=None, max_length=250)
    state: (
        Literal[
            "RESOLVED",
            "MISSING",
            "AMBIGUOUS",
            "INVALID",
            "REFERENCE_PENDING",
            "AUTHORITY_LOOKUP_REQUIRED",
            "UNSUPPORTED",
        ]
        | None
    ) = None
    selectionStrategy: Name | None = None
    candidates: list[ReferenceCandidate] = Field(default_factory=list, max_length=51)


class Relationship(SemanticValue):
    model_config = ConfigDict(
        extra="forbid", strict=True, allow_inf_nan=False, serialize_by_alias=True
    )
    from_: Name = Field(alias="from")
    relation: Literal["uses", "precedes", "modifies", "refers_to"]
    to: Name


class ResolvedSlot(SemanticValue):
    code: Name
    state: Literal[
        "RESOLVED",
        "MISSING",
        "AMBIGUOUS",
        "INVALID",
        "REFERENCE_PENDING",
        "AUTHORITY_LOOKUP_REQUIRED",
        "UNSUPPORTED",
    ]
    requirement: Name
    source: Text | None = None
    value: JsonValue = None
    candidates: list[JsonValue] = Field(default_factory=list, max_length=128)
    confidence: float = Field(ge=0, le=1)
    requiresAuthorizationLookup: bool


class ResolvedAmbiguity(SemanticValue):
    span: Text
    candidates: list[ReferenceCandidate] = Field(max_length=128)
    clarificationRequired: bool


class SemanticGraphNode(SemanticValue):
    id: Name
    kind: Name
    clauseId: Name | None = None
    value: JsonValue = None


class SemanticGraphEdge(SemanticValue):
    model_config = ConfigDict(
        extra="forbid", strict=True, allow_inf_nan=False, serialize_by_alias=True
    )
    from_: Name = Field(alias="from")
    to: Name
    relation: Name
    ruleCode: Name | None = None


class SemanticGraph(SemanticValue):
    nodes: list[SemanticGraphNode] = Field(max_length=256)
    edges: list[SemanticGraphEdge] = Field(max_length=512)
    constraints: list[Name] = Field(max_length=256)
    truncated: bool

    @model_validator(mode="after")
    def valid_links(self) -> "SemanticGraph":
        ids = {node.id for node in self.nodes}
        if len(ids) != len(self.nodes):
            raise ValueError("Duplicate graph node IDs")
        if any(edge.from_ not in ids or edge.to not in ids for edge in self.edges):
            raise ValueError("Graph edge references an unknown node")
        if any(value not in ids for value in self.constraints):
            raise ValueError("Graph constraint references an unknown node")
        if any(
            node.clauseId is not None and node.clauseId not in ids
            for node in self.nodes
        ):
            raise ValueError("Graph node references an unknown clause")
        return self


class Confidence(Contract):
    raw: float = Field(ge=0, le=1)
    calibrated: float | None = Field(default=None, ge=0, le=1)
    band: Literal["HIGH", "MEDIUM", "LOW", "AMBIGUOUS"] | None = None


class InterpretationProvenance(Contract):
    wire_contract: Literal["legacy-v1", "language-v2"] = "legacy-v1"
    engine_version: Name | None = None
    dictionary_version: Name | None = None
    compiler_version: Name | None = None
    release_id: Name | None = None
    generation_fingerprint: Fingerprint | None = None
    runtime_version: Fingerprint | None = None
    normalization_version: Literal["english-v1"] | None = None
    clause_span_encoding: Literal["utf-16-code-units"] | None = None
    evidence_span_encoding: Literal["unicode-code-points"] | None = None
    # None means unreported, not an invented version or calibrated score.


class RequestedActions(RequestedActionMetadata):
    """Validated ordered linguistic actions; never execution authority."""

    model_config = ConfigDict(strict=True, extra="forbid")


class InterpretedRequest(Contract):
    request_id: Identifier
    status: Literal[
        "RESOLVED", "NEEDS_CONTEXT", "AMBIGUOUS", "UNKNOWN", "UNSUPPORTED", "DENIED"
    ]
    primary_intent: Name | None = None
    reason: Literal["unsupported_capability", "access_denied"] | None = None
    unsupported_intents: list[Name] = Field(default_factory=list, max_length=32)
    legacy_intent: Name | None = None
    request_type: Name | None = None
    requested_actions: RequestedActions = Field(default_factory=RequestedActions)
    compound_reply: Literal["filled", "replaced", "cancelled", "rejected"] | None = None
    compound_interpretation_version: int | None = Field(
        default=None, strict=True, ge=1, le=1
    )
    interpretation_text: Text | None = None
    clause_source_text: Text | None = None
    search_update: bool = False
    clarification_reply: bool = False
    message: str = Field(max_length=1000)
    confidence: Confidence
    requires_confirmation: bool = False
    entities: dict[str, JsonValue] = Field(default_factory=dict, max_length=64)
    slots: dict[str, JsonValue] = Field(default_factory=dict, max_length=64)
    clauses: list[Clause] = Field(default_factory=list, max_length=33)
    actions: list[Action] = Field(default_factory=list, max_length=66)
    operations: list[Name] = Field(default_factory=list, max_length=66)
    references: list[Reference] = Field(default_factory=list, max_length=128)
    relationships: list[Relationship] = Field(default_factory=list, max_length=256)
    missing: list[Name] = Field(default_factory=list, max_length=128)
    ambiguities: list[dict[str, JsonValue]] = Field(default_factory=list, max_length=32)
    graph: SemanticGraph | None = None
    context_next: dict[str, JsonValue] = Field(default_factory=dict, max_length=32)
    provenance: InterpretationProvenance = Field(
        default_factory=InterpretationProvenance
    )

    @model_validator(mode="after")
    def valid_action_links(self) -> "InterpretedRequest":
        if self.clause_source_text is not None:
            validate_clause_spans(self.clauses, self.clause_source_text)
        if (
            self.compound_interpretation_version is not None
            and self.requested_actions.requestedActionsVersion is None
        ):
            raise ValueError(
                "Compound interpretation requires requested-action metadata"
            )
        clauses = {clause.id for clause in self.clauses}
        actions = {action.id for action in self.actions}
        if (
            len(clauses) != len(self.clauses)
            or len(actions) != len(self.actions)
            or clauses & actions
        ):
            raise ValueError("Duplicate semantic IDs")
        items = self.entities.get("items", [])
        if not isinstance(items, list) or len(items) > 51:
            raise ValueError("Invalid semantic item collection")
        for action in self.actions:
            if action.clauseId not in clauses:
                raise ValueError("Action references an unknown clause")
            if any(index >= len(items) for index in action.itemIndexes):
                raise ValueError("Action references an unknown item")
            if len(set(action.itemIndexes)) != len(action.itemIndexes):
                raise ValueError("Duplicate action item indexes")
        targets = clauses | actions | {f"item{i + 1}" for i in range(len(items))}
        targets |= {"request", "request.items"}
        targets |= {key for key in ("delivery", "order") if key in self.entities}
        for reference in self.references:
            if not reference.resolved:
                continue
            if reference.kind == "product" and reference.target not in {
                f"item{i + 1}" for i in range(len(items))
            }:
                raise ValueError("Reference targets an unknown item")
            if reference.kind == "action" and reference.target not in actions:
                raise ValueError("Reference targets an unknown action")
        for relation in self.relationships:
            if relation.from_ not in targets or relation.to not in targets:
                raise ValueError("Relationship references an unknown semantic ID")
            if relation.relation == "precedes" and (
                relation.from_ not in actions
                or relation.to not in actions
                or relation.from_ == relation.to
            ):
                raise ValueError("Precedence must link distinct actions")
        return self

    @property
    def needs_clarification(self) -> bool:
        return self.status in {"NEEDS_CONTEXT", "AMBIGUOUS"}

    @property
    def allows_fallback(self) -> bool:
        return self.status == "UNKNOWN"


class InterpretationFailure(Contract):
    request_id: Identifier
    code: Literal[
        "unavailable",
        "invalid_response",
        "incompatible_version",
        "incompatible_release",
    ]
    # Intentionally no UNKNOWN status: failures cannot admit a model call.
