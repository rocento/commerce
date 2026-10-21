import { expectTypeOf, it } from "vitest";
import type { components, paths } from "./schema";

it("preserves runtime nulls and required market path parameters in generated clients", () => {
  type Order = components["schemas"]["OrderDetail"];
  expectTypeOf<null>().toExtend<Order["dispatch"]>();
  expectTypeOf<null>().toExtend<Order["fulfillment_plan"]>();
  expectTypeOf<NonNullable<Order["dispatch"]>>().toEqualTypeOf<components["schemas"]["Dispatch"]>();
  type MarketPath = paths["/v1/admin/markets/{market}/{kind}/{id}"]["get"]["parameters"]["path"];
  expectTypeOf<MarketPath>().toEqualTypeOf<{ market: string; kind: "product" | "category" | "navigation"; id: string }>();
});
