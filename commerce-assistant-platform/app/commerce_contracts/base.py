"""Immutable versioned values shared across engine contracts."""

from typing import Literal

from pydantic import BaseModel, ConfigDict


class Contract(BaseModel):
    model_config = ConfigDict(
        extra="forbid", frozen=True, strict=True, allow_inf_nan=False
    )
    schema_version: Literal["1.0"] = "1.0"
