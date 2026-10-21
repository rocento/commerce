import { describe, expect, it } from "vitest";
import type { AttributeDefinition } from "@commerce/api-client";
import { attributeFilterOptions, attributeFiltersFromForm, readAttributeFilters, removeAttributeFilter, selectedAttributeValues } from "./attribute-filters";

const color = {attribute_code:"color",input_type:"select",options:[{value:"red",label:"Red"},{value:"blue",label:"Blue"},{value:"green",label:"Green"}],metadata:{facetable:true}} as AttributeDefinition;
describe("layered attribute navigation", () => {
  it("submits all checked alternatives, retains false and numeric types", () => {
    const form = new FormData();
    for (const [key,value] of [["attr:color","red"],["attr:color","blue"],["attr-mode:color","multiple"],["attr-type:color","select"],["attr:organic","false"],["attr-mode:organic","multiple"],["attr-type:organic","boolean"],["attr:weight","2.5"],["attr-type:weight","measurement"],["attr:empty",""]]) form.append(key,value);
    expect(attributeFiltersFromForm(form)).toEqual({color:["red","blue"],organic:[false],weight:2.5});
  });
  it("restores scalar links and array links, including boolean false", () => {
    expect(selectedAttributeValues(false)).toEqual(["false"]);
    expect(selectedAttributeValues(["red","blue"])).toEqual(["red","blue"]);
    expect(readAttributeFilters(new URLSearchParams("attributes=bad"))).toEqual({});
    expect(readAttributeFilters(new URLSearchParams('attributes=[]'))).toEqual({});
  });
  it("uses server counts, hides empty values and retains zero-match selections", () => {
    expect(attributeFilterOptions(color,{color:{red:4,blue:2}},["green"],"Yes","No")).toEqual([
      {value:"red",label:"Red",count:4},{value:"blue",label:"Blue",count:2},{value:"green",label:"Green",count:0}]);
    expect(attributeFilterOptions(color,{},[],"Yes","No")).toEqual([]);
    expect(attributeFilterOptions(color,undefined,[],"Yes","No")).toHaveLength(3);
  });
  it("turns facetable text values into choices without inventing counts", () => {
    const brand: AttributeDefinition = {...color,attribute_code:"brand",input_type:"text",options:[]};
    expect(attributeFilterOptions(brand,{brand:{Acme:8}},[],"Yes","No")).toEqual([{value:"Acme",label:"Acme",count:8}]);
    expect(attributeFilterOptions({...color,metadata:{facetable:false}}, {}, [],"Yes","No")[0].count).toBeUndefined();
  });
  it("removes just one selection while preserving category, locale and sorting", () => {
    const params = new URLSearchParams({attributes:JSON.stringify({color:["red","blue"],organic:false}),category:"fruit",lang:"ar",sort_by:"price",offset:"24"});
    const next = removeAttributeFilter(params,"color","red");
    expect(readAttributeFilters(next)).toEqual({color:["blue"],organic:false});
    for (const key of ["category","lang","sort_by"]) expect(next.get(key)).toBe(params.get(key));
    expect(next.has("offset")).toBe(false);
    const cleared = removeAttributeFilter(removeAttributeFilter(next,"color","blue"),"organic","false");
    expect(cleared.has("attributes")).toBe(false);
  });
});
