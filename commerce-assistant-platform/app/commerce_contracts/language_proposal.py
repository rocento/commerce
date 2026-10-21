"""Untrusted model proposal, requiring a fresh language-engine interpretation."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

CONVERSATION_INTENTS = frozenset(
    {
        "CONVERSATION_OFF_TOPIC",
        "CONVERSATION_JOKE",
        "CONVERSATION_HOSTILE",
        "CONVERSATION_UNVERIFIED_CLAIM",
        "CONVERSATION_MANIPULATION",
        "CONVERSATION_STORE_FEEDBACK",
        "CONVERSATION_GREETING",
        "CONVERSATION_THANKS",
        "CONVERSATION_HELP",
    }
)


class LanguageProposal(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    status: Literal["INTERPRETED", "CONVERSATION", "CLARIFY"]
    intent: str | None = Field(max_length=128)
    canonical_text: str | None = Field(max_length=4000)

    @model_validator(mode="after")
    def consistent_proposal(self) -> "LanguageProposal":
        if self.status == "INTERPRETED":
            if (
                not self.intent
                or not self.intent.strip()
                or self.intent in CONVERSATION_INTENTS
                or not self.canonical_text
                or not self.canonical_text.strip()
            ):
                raise ValueError(
                    "An interpretation needs a commerce intent and request"
                )
        elif self.status == "CONVERSATION":
            if (
                self.intent not in CONVERSATION_INTENTS
                or self.canonical_text is not None
            ):
                raise ValueError("Conversation requires a reply intent and no action")
        elif self.intent is not None or self.canonical_text is not None:
            raise ValueError("Clarification cannot also propose an action")
        return self
