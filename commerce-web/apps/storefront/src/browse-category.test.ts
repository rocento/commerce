import { describe, expect, it } from "vitest";
import type { Category } from "@commerce/api-client";
import { browseCategoryReferences, replaceBrowseCategories, resolveBrowseCategory } from "./browse-category";

const category = { id: "43f2cd55-a3e8-4caa-9822-47aa6b2368d9", slug: "egyptian-breakfast" } as Category;
describe("browse category links", () => {
  it("resolves menu slugs to the UUID required by search", () => {
    expect(resolveBrowseCategory([category], "egyptian-breakfast")?.id).toBe(category.id);
  });
  it("preserves existing UUID links", () => {
    expect(resolveBrowseCategory([category], category.id)).toBe(category);
  });
  it("does not turn unknown category links into an unfiltered search", () => {
    expect(resolveBrowseCategory([category], "missing-category")).toBeUndefined();
    expect(resolveBrowseCategory([category])).toBeUndefined();
  });
});

describe("category checkbox selections", () => {
  it("reads legacy single selections and repeated selections without duplicates", () => {
    expect(browseCategoryReferences(new URLSearchParams("category=fruit"))).toEqual(["fruit"]);
    expect(browseCategoryReferences(new URLSearchParams("category=fruit&category=vegetables&category=fruit&category="))).toEqual(["fruit", "vegetables"]);
  });
  it("preserves other filters, replaces every selection and resets pagination", () => {
    const original = new URLSearchParams("category=fruit&q=tea&min=2&max=15&stock=true&sort_by=price&offset=48&lang=ar");
    const next = replaceBrowseCategories(original, ["vegetables", "fruit"]);
    expect(next.getAll("category")).toEqual(["vegetables", "fruit"]);
    for (const key of ["q", "min", "max", "stock", "sort_by", "lang"]) expect(next.get(key)).toBe(original.get(key));
    expect(next.has("offset")).toBe(false);
    expect(original.get("offset")).toBe("48");
  });
  it("clears the category restriction when every checkbox is unchecked", () => {
    const next = replaceBrowseCategories(new URLSearchParams("category=fruit&category=vegetables&q=tea&offset=24"), []);
    expect(next.has("category")).toBe(false);
    expect(next.get("q")).toBe("tea");
    expect(next.has("offset")).toBe(false);
  });
});
