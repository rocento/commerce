"""Deterministic account views that do not need a model call."""

import re


def saved_addresses_requested(message: str) -> bool:
    text = message.lower().strip()
    address = r"(?:address(?:es)?|adress(?:es)?|addres|locations?)"
    if not re.search(rf"\b{address}\b", text):
        return False
    if re.search(
        r"\b(?:add|save|create|change|edit|update|delete|remove|email|e-mail)\b", text
    ):
        return False
    return bool(
        re.search(r"\b(?:my|saved)\b", text)
        or re.fullmatch(rf"(?:show |view |list )?{address}[?!.]*", text)
    )
