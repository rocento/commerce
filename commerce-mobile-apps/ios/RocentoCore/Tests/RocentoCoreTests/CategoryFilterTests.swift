import XCTest
@testable import RocentoCore

final class CategoryFilterTests: XCTestCase {
  func testGlobalSearchOmitsCategoryAndKeepsQueryAndPaging() {
    var filters = CatalogFilters()
    filters.query = "pear & apple"
    let query = filters.parameters(category: "", offset: 24)
    XCTAssertFalse(query.contains { $0.name == "category_id" })
    XCTAssertEqual(query.first { $0.name == "q" }?.value, "pear & apple")
    XCTAssertEqual(query.first { $0.name == "offset" }?.value, "24")
  }
  private func attribute(_ type: String = "select") throws -> CatalogAttribute {
    let json = """
    {"attribute_code":"food_form","label":"Food form","input_type":"\(type)","is_filterable":true,"is_visible_on_front":true,"options":[{"value":"Fillets","label":"Fillets"},{"value":"Whole","label":"Whole"}],"metadata":{"facetable":true}}
    """
    return try JSONDecoder().decode(CatalogAttribute.self, from: Data(json.utf8))
  }
  func testAbsentFacetHidesUnrelatedAttributeAndKeepsSelectionsRemovable() throws {
    let form = try attribute()
    XCTAssertFalse(form.showsFilter(facets: [:], selected: []))
    XCTAssertEqual(form.choices(facets: [:], selected: []), [])
    XCTAssertTrue(form.showsFilter(facets: [:], selected: ["Fillets"]))
    XCTAssertEqual(form.choices(facets: [:], selected: ["Fillets"]), ["Fillets"])
    XCTAssertEqual(form.choices(facets: ["Whole": 3, "Fillets": 0], selected: []), ["Whole"])
    XCTAssertTrue(form.showsFilter(facets: nil, selected: []))
  }
  func testNumericFiltersUseExactInputEvenWithFacets() throws {
    let weight = try attribute("integer")
    XCTAssertFalse(weight.usesChoices)
    XCTAssertTrue(weight.showsFilter(facets: [:], selected: []))
    XCTAssertTrue(try attribute("text").usesChoices)
  }
}
