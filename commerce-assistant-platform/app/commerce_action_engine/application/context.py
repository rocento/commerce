"""Authenticated turn identity; construct at the trusted application boundary."""

from typing import Annotated

from pydantic import Field

from app.commerce_action_engine.contracts.action import (
    ActorContext,
    Contract,
    Identifier,
    Timestamp,
)


class TurnContext(Contract):
    actor: ActorContext
    conversation_id: Identifier | None = None
    locale: Annotated[str, Field(min_length=2, max_length=35)] = "en"
    currency: Annotated[str, Field(pattern=r"^[A-Z]{3}$")] | None = None
    deadline_at: Timestamp | None = None

    # ActorContext already defines tenant, store, session, request and scopes.
    # Do not duplicate those identifiers or accept them from interpretation JSON.
