"""Catalog data and argument contracts, independent of transport and runtime."""

from typing import Annotated, Literal
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictFloat,
    StrictInt,
    StrictStr,
    model_validator,
)

from app.commerce_action_engine.actions.catalog.discovery import (
    MAX_CATALOG_RESULTS,
    Discovery,
    DiscoveryReport,
)


class DTO(BaseModel):
    model_config = ConfigDict(extra="forbid")


# Strings with UUID patterns preserve strict model-argument validation across JSON/dict boundaries.
Identifier = Annotated[
    str,
    Field(
        pattern=r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
    ),
]
Money = Annotated[str, Field(pattern=r"^\d{1,12}(\.\d{1,6})?$")]


class ProductArgs(DTO):
    product_id: Identifier


class CategoryArgs(DTO):
    category_id: Identifier


class CompareArgs(DTO):
    product_ids: list[Identifier] = Field(min_length=2, max_length=5)


class SchemaArgs(DTO):
    pass


class SearchAttribute(DTO):
    name: str = Field(min_length=1, max_length=64)
    value: StrictStr | StrictBool | StrictInt | StrictFloat


class SearchPredicate(DTO):
    name: str = Field(min_length=1, max_length=64)
    operator: Literal["eq", "neq", "lt", "lte", "gt", "gte", "contains"]
    value: StrictStr | StrictBool | StrictInt | StrictFloat


class SearchFields(DTO):
    query: str = Field(min_length=1, max_length=200)
    category_id: Identifier | None = None
    currency: str | None = Field(
        default=None, pattern=r"^[A-Z]{3}$", exclude_if=lambda value: value is None
    )
    min_price: Money | None = None
    max_price: Money | None = None
    exclusive_min: bool = Field(default=False, exclude_if=lambda value: not value)
    exclusive_max: bool = Field(default=False, exclude_if=lambda value: not value)
    in_stock: bool = Field(default=False, exclude_if=lambda value: not value)
    excluded_product_ids: list[Identifier] = Field(
        default_factory=list, max_length=20, exclude_if=lambda value: not value
    )
    predicates: list[SearchPredicate] = Field(
        default_factory=list, max_length=20, exclude_if=lambda value: not value
    )


class SearchArgs(SearchFields):
    # Commerce HTTP facade contract, which accepts attribute maps.
    attributes: dict[str, StrictStr | StrictBool | StrictInt | StrictFloat] = Field(
        default_factory=dict, max_length=20
    )


class SearchToolArgs(SearchFields):
    # Model tools require closed object schemas. Convert this bounded list to
    # the commerce facade's attribute map only at the transport boundary.
    attributes: list[SearchAttribute] = Field(default_factory=list, max_length=20)


class Attribute(DTO):
    name: str = Field(max_length=100)
    value: str = Field(max_length=250)
    label: str = Field(default="", max_length=120)
    source: Literal["VERIFIED", "MERCHANT", "IMPORTED", "DERIVED", "AI_INFERRED"] = (
        "MERCHANT"
    )
    confidence: float | None = Field(default=None, ge=0, le=1)
    comparable: bool = True


class Product(DTO):
    discovery: Discovery | None = Field(
        default=None, exclude_if=lambda value: value is None
    )
    id: UUID
    image_id: UUID | None = None
    name: str = Field(max_length=1000)
    sku: str = Field(default="", max_length=200, exclude_if=lambda value: not value)
    price: Money
    currency: str = Field(min_length=3, max_length=3)
    category_id: UUID
    category_ids: list[UUID] = Field(default_factory=list, max_length=50)
    category_name: str = Field(default="", max_length=1000)
    category_names: list[str] = Field(default_factory=list, max_length=50)
    product_type: str = Field(max_length=50)
    attributes: list[Attribute] = Field(max_length=20)
    in_stock: bool | None
    route: str = Field(pattern=r"^/products/[0-9a-fA-F-]{36}$")

    @model_validator(mode="after")
    def validate_offer(self) -> "Product":
        if self.discovery:
            offer = self.discovery.offer
            if (
                offer.product_id,
                offer.category_id,
                offer.price,
                offer.currency,
                offer.in_stock,
            ) != (self.id, self.category_id, self.price, self.currency, self.in_stock):
                raise ValueError("Discovery evidence must match the current product")
        return self


class Category(DTO):
    id: UUID
    name: str = Field(max_length=1000)
    parent_id: UUID | None


class SchemaOption(DTO):
    code: str = Field(max_length=100)
    label: str = Field(max_length=120)
    labels: dict[str, str] = Field(default_factory=dict, max_length=20)


class SchemaAttribute(DTO):
    code: str = Field(max_length=64)
    label: str = Field(max_length=120)
    description: str = Field(default="", max_length=500)
    data_type: str = Field(max_length=30)
    options: list[SchemaOption] = Field(max_length=100)
    filterable: bool
    searchable: bool
    facetable: bool
    sortable: bool
    comparable: bool
    variant_axis: bool
    source_policy: Literal["factual", "semantic", "trusted_only"]
    semantic_role: str | None = None
    unit: str | None
    min: float | None
    max: float | None


class SchemaCategory(DTO):
    id: UUID
    name: str = Field(max_length=1000)
    parent_id: UUID | None = None
    aliases: list[str] = Field(default_factory=list, max_length=12)
    sellable_count: int = Field(default=0, ge=0)


class CatalogSchema(DTO):
    industry: str | None
    version: str = Field(max_length=200)
    attributes: list[SchemaAttribute] = Field(max_length=100)
    categories: list[SchemaCategory] = Field(default_factory=list, max_length=200)
    categories_complete: bool = True


class CatalogFacetValue(DTO):
    value: StrictStr | StrictBool | StrictInt | StrictFloat
    label: str = Field(max_length=120)
    count: int = Field(ge=0)


class CatalogFacet(DTO):
    code: str = Field(max_length=64)
    label: str = Field(max_length=120)
    data_type: str = Field(max_length=30)
    unit: str | None = None
    covered_count: int = Field(ge=0)
    values: list[CatalogFacetValue] = Field(max_length=24)
    values_complete: bool


class CatalogPriceRange(DTO):
    currency: str = Field(pattern=r"^[A-Z]{3}$")
    min: Money
    max: Money
    count: int = Field(ge=0)


class CatalogProfile(DTO):
    revision: str = Field(min_length=1, max_length=200)
    scope: Literal["current_sellable_catalog", "current_sellable_category"]
    complete: bool
    candidate_count: int = Field(ge=0)
    matched_count: int = Field(ge=0)
    facets: list[CatalogFacet] = Field(max_length=30)
    facets_complete: bool
    prices: list[CatalogPriceRange] = Field(max_length=20)

    @model_validator(mode="after")
    def consistent_counts(self) -> "CatalogProfile":
        if self.matched_count > self.candidate_count or any(
            facet.covered_count > self.matched_count
            or any(value.count > facet.covered_count for value in facet.values)
            for facet in self.facets
        ):
            raise ValueError("Catalog profile counts must refer to matched SKUs")
        return self


class CatalogResult(DTO):
    discovery: DiscoveryReport | None = Field(
        default=None, exclude_if=lambda value: value is None
    )
    products: list[Product] = Field(max_length=MAX_CATALOG_RESULTS)
    category: Category | None
    catalog_schema: CatalogSchema | None = None
    catalog_profile: CatalogProfile | None = Field(
        default=None, exclude_if=lambda value: value is None
    )
    default_currency: str | None = Field(
        default=None, pattern=r"^[A-Z]{3}$", exclude_if=lambda value: value is None
    )
