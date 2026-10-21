"""Conservative policy identity checks; semantic contradictions require review."""

import unicodedata


def policy_identity(title: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", title).casefold().split())
