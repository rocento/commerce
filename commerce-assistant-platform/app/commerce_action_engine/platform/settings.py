"""AI-only configuration. No commerce database or general-purpose credentials."""

import os
import re
from dataclasses import dataclass
from pathlib import Path
from uuid import UUID


@dataclass(frozen=True)
class Settings:
    enabled: bool = False
    tenant_id: str = ""
    verification_key: str = ""
    commerce_url: str = "http://assistant-tools:8081"
    concurrency: int = 8
    turn_timeout: float = 25
    store_password_file: str = ""
    store_host: str = "ai-postgres"
    store_user: str = "ai_runtime"

    model_provider: str = "disabled"
    model_name: str = "gpt-4.1-mini"
    model_key_file: str = ""
    model_timeout: float = 20
    model_url: str = "https://api.openai.com/v1/responses"
    model_max_calls_per_turn: int = 2
    model_daily_token_budget: int = 0
    model_session_token_budget: int = 0
    model_input_micros_per_1k: int = 0
    model_output_micros_per_1k: int = 0
    exact_policy_file: str = ""
    feature_flags: frozenset[str] = frozenset()
    small_model_name: str = ""
    small_model_input_micros_per_1k: int = 0
    small_model_output_micros_per_1k: int = 0

    acceptance_file: str = ""
    provider_settings_file: str = ""

    language_engine_url: str = ""
    language_generation_fingerprint: str = ""
    embedding_model: str = ""
    knowledge_collections: tuple[str, ...] = ()
    intent_example_collection: str = ""
    semantic_recovery_embedding_budget: int = 0
    intent_tracking_enabled: bool = True
    core_journeys: frozenset[str] = frozenset(
        {"discovery", "shop", "optimize", "buy_again", "cart", "order", "general"}
    )

    @classmethod
    def environment(cls) -> "Settings":
        tenant = os.getenv("ASSISTANT_TENANT_ID", "")
        key_path = os.getenv("ASSISTANT_PUBLIC_KEY_FILE", "")
        # This describes infrastructure readiness, not the customer-facing
        # toggle. Admin-managed provider settings control new conversations.
        enabled = bool(tenant and key_path)
        if bool(tenant) != bool(key_path):
            raise ValueError(
                "Assistant tenant and verification key are required together"
            )
        if enabled:
            UUID(tenant)
        # Never support generic DATABASE_URL or inherited Commerce secrets.
        for name in (
            "DATABASE_URL",
            "AUTH_SECRET",
            "POSTGRES_PASSWORD",
            "S3_SECRET_KEY",
            "PAYMENT_SECRET",
            "ASSISTANT_PRIVATE_KEY_FILE",
        ):
            if os.getenv(name):
                raise ValueError("Forbidden Commerce credential in AI environment")
        url = os.getenv("ASSISTANT_COMMERCE_URL", "http://assistant-tools:8081")
        if url != "http://assistant-tools:8081":
            raise ValueError("Commerce tools must use the isolated fixed facade")
        max_calls = int(os.getenv("AI_MODEL_MAX_CALLS_PER_TURN", "2"))
        if not 1 <= max_calls <= 4:
            raise ValueError("AI_MODEL_MAX_CALLS_PER_TURN must be between 1 and 4")
        daily_budget = int(os.getenv("AI_MODEL_DAILY_TOKEN_BUDGET", "0"))
        session_budget = int(os.getenv("AI_MODEL_SESSION_TOKEN_BUDGET", "0"))
        input_price = int(os.getenv("AI_MODEL_INPUT_MICROS_PER_1K", "0"))
        output_price = int(os.getenv("AI_MODEL_OUTPUT_MICROS_PER_1K", "0"))
        if min(daily_budget, session_budget, input_price, output_price) < 0:
            raise ValueError("AI model token budgets cannot be negative")
        flags = frozenset(
            v.strip() for v in os.getenv("AI_FEATURE_FLAGS", "").split(",") if v.strip()
        )
        if flags - {
            "catalog_singleflight",
            "catalog_cache",
            "small_model",
            "typed_errors",
            "grounded_intent",
            "commerce_core",
            "commerce_meaning",
            "commerce_planning",
            "compound_execution",
            "semantic_read_recovery",
            "domain_evidence",
        }:
            raise ValueError("Unknown AI feature flag")
        small_model = os.getenv("AI_SMALL_MODEL_NAME", "").strip()
        if "small_model" in flags and not small_model:
            raise ValueError("AI_SMALL_MODEL_NAME is required for small_model")
        small_input = int(os.getenv("AI_SMALL_MODEL_INPUT_MICROS_PER_1K", "0"))
        small_output = int(os.getenv("AI_SMALL_MODEL_OUTPUT_MICROS_PER_1K", "0"))
        if min(small_input, small_output) < 0:
            raise ValueError("Model prices cannot be negative")
        from app.commerce_action_engine.execution.core.library import JOURNEYS

        core_journeys = frozenset(
            v.strip()
            for v in os.getenv("AI_CORE_JOURNEYS", ",".join(JOURNEYS)).split(",")
            if v.strip()
        )
        if core_journeys - set(JOURNEYS):
            raise ValueError("Unknown AI_CORE_JOURNEYS journey")
        recovery_budget = int(os.getenv("AI_SEMANTIC_RECOVERY_EMBEDDING_BUDGET", "0"))
        if recovery_budget not in {0, 1}:
            raise ValueError("Semantic recovery embedding budget must be zero or one")
        intent_collection = os.getenv("AI_INTENT_EXAMPLE_COLLECTION", "").strip()
        if intent_collection and not re.fullmatch(
            r"[a-zA-Z0-9_-]{1,100}", intent_collection
        ):
            raise ValueError("Invalid AI_INTENT_EXAMPLE_COLLECTION")
        knowledge_collections = tuple(
            value.strip()
            for value in os.getenv("AI_KNOWLEDGE_COLLECTIONS", "").split(",")
            if value.strip()
        )
        if intent_collection and intent_collection in knowledge_collections:
            raise ValueError("Intent examples require a separate knowledge collection")
        store_host = os.getenv("AI_STORE_HOST", "ai-postgres")
        store_user = os.getenv("AI_STORE_USER", "ai_runtime")
        if store_host not in {"ai-postgres", "shared-ai-postgres"}:
            raise ValueError("AI store must use an isolated AI database host")
        if store_user not in {
            "ai_runtime",
            *(
                f"ai_runtime_{s}"
                for s in ("grocery", "jewelry", "electronics", "pharmacy")
            ),
        }:
            raise ValueError("Invalid AI store runtime role")
        return cls(
            enabled,
            tenant,
            Path(key_path).read_text() if key_path else "",
            url,
            store_password_file=os.getenv("AI_STORE_PASSWORD_FILE", ""),
            store_host=store_host,
            store_user=store_user,
            embedding_model=os.getenv("AI_EMBEDDING_MODEL", ""),
            intent_example_collection=intent_collection,
            semantic_recovery_embedding_budget=recovery_budget,
            knowledge_collections=knowledge_collections,
            acceptance_file=os.getenv("AI_ACCEPTANCE_FILE", ""),
            provider_settings_file=os.getenv("AI_PROVIDER_SETTINGS_FILE", ""),
            intent_tracking_enabled=os.getenv(
                "AI_INTENT_TRACKING_ENABLED", "true"
            ).lower()
            == "true",
            model_provider=os.getenv("AI_MODEL_PROVIDER", "disabled"),
            model_name=os.getenv("AI_MODEL_NAME", "").strip() or "gpt-4.1-mini",
            model_key_file=os.getenv("AI_MODEL_KEY_FILE", ""),
            model_timeout=float(os.getenv("AI_MODEL_TIMEOUT_SECONDS", "20")),
            model_url=os.getenv("AI_MODEL_URL", "https://api.openai.com/v1/responses"),
            model_max_calls_per_turn=max_calls,
            model_daily_token_budget=daily_budget,
            model_session_token_budget=session_budget,
            model_input_micros_per_1k=input_price,
            model_output_micros_per_1k=output_price,
            exact_policy_file=os.getenv("AI_EXACT_POLICY_FILE", ""),
            feature_flags=flags,
            language_engine_url=os.getenv("AI_LANGUAGE_ENGINE_URL", ""),
            language_generation_fingerprint=os.getenv(
                "AI_LANGUAGE_GENERATION_FINGERPRINT", ""
            ).strip(),
            core_journeys=core_journeys,
            small_model_name=small_model,
            small_model_input_micros_per_1k=small_input,
            small_model_output_micros_per_1k=small_output,
        )
