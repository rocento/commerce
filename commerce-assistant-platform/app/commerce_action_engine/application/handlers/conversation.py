"""Agent-owned replies; conversation classifications never execute commerce tools."""

from types import MappingProxyType

REPLIES = MappingProxyType(
    {
        "CONVERSATION_OFF_TOPIC": (
            "I'm here to help with this store's products, shopping, and orders. "
            "What can I help you find or check?"
        ),
        "CONVERSATION_JOKE": (
            "Keeping it light! I'll leave your shopping as it is. "
            "Let me know if you'd like help finding something."
        ),
        "CONVERSATION_HOSTILE": (
            "I'm here to help. Tell me what went wrong or what you need, "
            "and we can work through it."
        ),
        "CONVERSATION_UNVERIFIED_CLAIM": (
            "I can't confirm that from your message alone. "
            "Which product or order should I check? "
            "The store's support team can help with claims that need further review."
        ),
        "CONVERSATION_MANIPULATION": (
            "I can help with legitimate shopping requests, but I can't bypass "
            "account checks, invent store information, or pretend a change was made. "
            "What would you like to find or check?"
        ),
        "CONVERSATION_STORE_FEEDBACK": (
            "It sounds like you're reporting a problem with the store experience. "
            "Tell me which page or feature is affected and what happens. "
            "You can also use Open a ticket to send the details to support."
        ),
        "CONVERSATION_GREETING": (
            "Hi! I can help you find products, manage your cart, or check an order. "
            "What would you like help with?"
        ),
        "CONVERSATION_THANKS": "You're welcome! Let me know if you need anything else.",
        "CONVERSATION_HELP": (
            "I can help you find products, compare options, manage your cart, "
            "and check your orders. Tell me what you need, and I'll guide you."
        ),
    }
)


def conversation_reply(intent: str | None) -> str:
    return REPLIES.get(intent or "", REPLIES["CONVERSATION_HELP"])
