"""Shared vector shape for provider output and the approved-knowledge index."""

import math

DIMENSIONS = 1536


class InvalidVectors(ValueError):
    """A vector batch does not satisfy the embedding contract."""


def validate_vectors(vectors: list[list[float]], count: int) -> None:
    if len(vectors) != count:
        raise InvalidVectors("invalid_embeddings")
    for vector in vectors:
        if len(vector) != DIMENSIONS or any(
            type(x) not in (int, float) or not math.isfinite(x) for x in vector
        ):
            raise InvalidVectors("invalid_embeddings")
        if sum(x * x for x in vector) <= 0:
            raise InvalidVectors("invalid_embeddings")
