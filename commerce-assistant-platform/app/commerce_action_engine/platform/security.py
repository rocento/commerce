"""Gateway authentication and verified request context."""

import time
from uuid import UUID

import jwt
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict

from .settings import Settings


class Context(BaseModel):
    model_config = ConfigDict(extra="forbid")
    iss: str
    aud: str
    tenant: UUID
    sub: UUID | None
    sid: UUID | None
    request_id: UUID
    iat: int
    exp: int
    scope: str


def authenticate(value: str, settings: Settings, scope: str = "chat") -> Context:
    try:
        claims = jwt.decode(
            value,
            settings.verification_key,
            algorithms=["RS256"],
            audience="ai-service",
            issuer="commerce-assistant",
            options={
                "verify_sub": False,
                "require": [
                    "exp",
                    "iat",
                    "aud",
                    "iss",
                    "tenant",
                    "request_id",
                    "scope",
                ],
            },
        )
        context = Context.model_validate(claims)
        if (
            str(context.tenant) != settings.tenant_id
            or context.scope != scope
            or context.exp - context.iat > 60
            or context.iat > time.time()
            or (context.sub is None) != (context.sid is None)
        ):
            raise ValueError("Invalid context")
        return context
    except (jwt.PyJWTError, ValueError):
        raise HTTPException(401, "Invalid assistant context") from None
