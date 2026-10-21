import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { EntityIdCell, EntityIdLabel, matchesEntityId, numericEntityId } from "./entity-id";
import { useLocalGrid } from "./local-grid";

it("displays only positive safe numeric IDs and keeps UUID target references separate", () => {
  expect(numericEntityId({ entity_id: 123 })).toBe(123);
  for (const entity_id of [undefined, 0, -1, "uuid-target", 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(numericEntityId({ entity_id })).toBeNull();
  expect(renderToStaticMarkup(<table><tbody><tr><EntityIdCell row={{ entity_id: 123 }}/></tr></tbody></table>)).toContain(">123</td>");
  expect(renderToStaticMarkup(<EntityIdLabel row={{ entity_id: "uuid-target" }}/>)).toBe("");
});

it("offers numeric entity sorting only for collections with numeric IDs", () => {
  function Grid({ rows }: { rows: { name: string; entity_id?: number }[] }) {
    const grid = useLocalGrid({ name: "themes", rows, searchText: row => row.name, sorts: { name: row => row.name }, initialSort: "name", busy: false, refresh: () => {} });
    return grid.controls;
  }
  expect(renderToStaticMarkup(<Grid rows={[{ name: "Theme", entity_id: 12 }]}/>)).toContain('value="entity_id"');
  expect(renderToStaticMarkup(<Grid rows={[{ name: "Theme" }]}/>)).not.toContain('value="entity_id"');
});

it("finds an exact entity number with either plain or hash-prefixed queries", () => {
  const row = { entity_id: 123 };
  for (const query of ["123", "#123", " #123 "]) expect(matchesEntityId(row, query)).toBe(true);
  for (const query of ["12", "theme", "", "1e2", "-123", "#"]) expect(matchesEntityId(row, query)).toBe(false);
});

it("sorts entity numbers numerically and places legacy rows without a number last", () => {
  function Grid() {
    const grid = useLocalGrid({ name: "themes", rows: [{ name: "Twenty", entity_id: 20 }, { name: "Three", entity_id: 3 }, { name: "Legacy" }], searchText: row => row.name, sorts: { name: row => row.name }, initialSort: "entity_id", busy: false, refresh: () => {} });
    return <p>{grid.data.map(row => row.name).join(", ")}</p>;
  }
  expect(renderToStaticMarkup(<Grid/>)).toBe("<p>Three, Twenty, Legacy</p>");
});
