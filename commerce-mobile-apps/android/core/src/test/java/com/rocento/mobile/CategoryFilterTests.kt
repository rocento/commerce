package com.rocento.mobile

import org.junit.Assert.*
import org.junit.Test

class CategoryFilterTests {
    private val form = CatalogAttribute("food_form", "Food form", "select", true, true,
        listOf(CatalogAttribute.Option("Fillets", "Fillets"), CatalogAttribute.Option("Whole", "Whole")),
        CatalogAttribute.Metadata(facetable = true))
    @Test fun absentFacetHidesUnrelatedAttributeButSelectedValueRemainsRemovable() {
        assertFalse(form.showsFilter(emptyMap(), emptyList()))
        assertEquals(emptyList<String>(), form.choices(emptyMap(), emptyList()))
        assertTrue(form.showsFilter(emptyMap(), listOf("Fillets")))
        assertEquals(listOf("Fillets"), form.choices(emptyMap(), listOf("Fillets")))
        assertEquals(listOf("Whole"), form.choices(mapOf("Whole" to 3, "Fillets" to 0), emptyList()))
        assertTrue(form.showsFilter(null, emptyList())) // Facets not loaded yet.
    }
    @Test fun numericFiltersStayExactInputsEvenWhenFaceted() {
        val weight = form.copy(attribute_code = "weight", input_type = "integer")
        assertFalse(weight.usesChoices)
        assertTrue(weight.showsFilter(emptyMap(), emptyList()))
        assertTrue(form.copy(input_type = "text").usesChoices)
        assertFalse(form.copy(is_visible_on_front = false).showsFilter(null, emptyList()))
    }
}
