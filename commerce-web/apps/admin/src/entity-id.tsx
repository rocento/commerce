import type { ReactNode } from "react";
import "./grids.css";

export const numericEntityId = (row: unknown): number | null => {
  if (!row || typeof row !== "object" || !("entity_id" in row)) return null;
  const value = row.entity_id;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
};

export function matchesEntityId(row: unknown, query: string): boolean {
  const value = query.trim();
  return /^#?\d+$/.test(value) && numericEntityId(row) === Number(value.replace(/^#/, ""));
}

export function EntityIdHeading() {
  return <th scope="col">Entity ID</th>;
}

export function EntityIdCell({ row }: { row: unknown }) {
  return <td className="entity-id-cell">{numericEntityId(row) ?? "—"}</td>;
}

export function EntityIdLabel({ row, children }: { row: unknown; children?: ReactNode }) {
  const id = numericEntityId(row);
  return <>{children}{id !== null && <span className="entity-id-label">Entity ID {id}</span>}</>;
}
