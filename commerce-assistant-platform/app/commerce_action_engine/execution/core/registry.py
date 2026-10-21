"""Immutable exact-version registries. Resolution does not confer authorization."""

from collections.abc import Iterable, Mapping
from types import MappingProxyType

from app.commerce_action_engine.contracts.action import (
    ActorContext,
    Definition,
    DefinitionRef,
    ModelRequirements,
    PlaybookDefinition,
    ProviderCapabilities,
    SkillDefinition,
)


class RegistryError(ValueError):
    """Safe bounded code; never include rejected definitions or credentials."""


def reference(definition: Definition) -> DefinitionRef:
    return DefinitionRef(id=definition.id, version=definition.version)


class Registry:
    def __init__(
        self,
        definitions: Iterable[Definition],
        *,
        aliases: Mapping[str, DefinitionRef] | None = None,
        contracts: frozenset[str] = frozenset(),
    ):
        records: dict[tuple[str, str], Definition] = {}
        for definition in definitions:
            key = (definition.id, definition.version)
            if key in records:
                raise RegistryError("duplicate_definition")
            if not definition.id.startswith(definition.kind + "://"):
                raise RegistryError("definition_kind_mismatch")
            if definition.disabled_after is not None and (
                definition.deprecated_after is None
                or definition.disabled_after < definition.deprecated_after
            ):
                raise RegistryError("invalid_deprecation_window")
            if not definition.visibility.channels:
                raise RegistryError("empty_channel_visibility")
            if (
                isinstance(definition, SkillDefinition)
                and not {definition.input_contract, definition.output_contract}
                <= contracts
            ):
                raise RegistryError("missing_contract")
            records[key] = definition
        self._records = MappingProxyType(records)
        self._aliases = MappingProxyType(dict(aliases or {}))
        for alias, ref in self._aliases.items():
            if any(key[0] == alias for key in records):
                raise RegistryError("alias_shadows_identity")
            self._get(ref)
        for definition in records.values():
            self._walk(reference(definition), set(), set())

    def _get(self, ref: DefinitionRef) -> Definition:
        definition = self._records.get((ref.id, ref.version))
        if (
            definition is None
            or int(definition.schema_version.split(".")[0]) != ref.schema_major
        ):
            raise RegistryError("missing_or_incompatible_version")
        return definition

    @staticmethod
    def _dependencies(definition: Definition) -> tuple[DefinitionRef, ...]:
        refs = definition.dependencies
        if isinstance(definition, PlaybookDefinition):
            refs += definition.steps
        if len({(r.id, r.version) for r in refs}) != len(refs):
            raise RegistryError("duplicate_dependency")
        return refs

    def _walk(
        self,
        ref: DefinitionRef,
        visiting: set[tuple[str, str]],
        done: set[tuple[str, str]],
    ) -> tuple[Definition, ...]:
        key = (ref.id, ref.version)
        if key in visiting:
            raise RegistryError("cyclic_dependency")
        if key in done:
            return ()
        definition = self._get(ref)
        visiting.add(key)
        result: tuple[Definition, ...] = ()
        for dependency in self._dependencies(definition):
            if (
                isinstance(definition, PlaybookDefinition)
                and dependency in definition.steps
                and not isinstance(self._get(dependency), SkillDefinition)
            ):
                raise RegistryError("playbook_step_requires_skill")
            result += self._walk(dependency, visiting, done)
        visiting.remove(key)
        done.add(key)
        return (*result, definition)

    def resolve(
        self, ref: DefinitionRef, context: ActorContext, *, now: int
    ) -> tuple[Definition, ...]:
        resolved = self._walk(ref, set(), set())
        for definition in resolved:
            visibility = definition.visibility
            if (
                (visibility.tenants and context.tenant_id not in visibility.tenants)
                or context.channel not in visibility.channels
                or not set(visibility.required_scopes) <= set(context.scopes)
            ):
                raise RegistryError("definition_not_permitted")
            if (
                definition.disabled_after is not None
                and now >= definition.disabled_after
            ):
                raise RegistryError("definition_expired")
        return resolved

    def alias(self, alias: str, *, pinned: DefinitionRef) -> DefinitionRef:
        """Alias consumers pin the target too, so an alias edit cannot move them silently."""
        if self._aliases.get(alias) != pinned:
            raise RegistryError("alias_pin_mismatch")
        return pinned

    def visible(self, context: ActorContext, *, now: int) -> tuple[DefinitionRef, ...]:
        result = []
        for definition in self._records.values():
            try:
                self.resolve(reference(definition), context, now=now)
            except RegistryError:
                continue
            result.append(reference(definition))
        return tuple(result)


def select_model(
    profiles: tuple[ProviderCapabilities, ...],
    requirements: ModelRequirements,
    *,
    configured: frozenset[str],
) -> ProviderCapabilities:
    """Caller supplies permitted profiles in explicit preference order; no model names."""
    for profile in profiles:
        if (
            profile.profile not in configured
            or profile.max_context_tokens < requirements.context_tokens
        ):
            continue
        if all(
            not getattr(requirements, name) or getattr(profile, name)
            for name in (
                "structured_output",
                "tool_calling",
                "streaming",
                "vision",
                "usage_reporting",
            )
        ):
            return profile
    raise RegistryError("no_capable_configured_profile")
