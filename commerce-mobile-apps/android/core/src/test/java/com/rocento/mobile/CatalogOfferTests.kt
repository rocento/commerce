package com.rocento.mobile

import org.junit.Assert.assertEquals
import org.junit.Test

class CatalogOfferTests {
    @Test fun onlyMatchingLowerNonnegativeOffersChangeDisplayPrice() {
        val product = Product("p", "Product", "", "10", "USD", inStock = true)
        val cases = listOf(
            CatalogOffer("p","USD","10.00","8.00") to "8.00",
            CatalogOffer("other","USD","10","8") to "10",
            CatalogOffer("p","EGP","10","8") to "10",
            CatalogOffer("p","USD","12","8") to "10",
            CatalogOffer("p","USD","10","-1") to "10",
            CatalogOffer("p","USD","10","11") to "10",
            CatalogOffer("p","USD","10","0") to "0"
        )
        cases.forEach { (offer, expected) -> assertEquals(expected, product.copy(catalogOffer = offer).displayPrice) }
    }
}
