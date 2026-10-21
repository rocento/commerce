export function bestsellerDescription(period: string, scope?: "delivery_area" | "global") {
  const labels: Record<string, string> = { today: "today", last_week: "last calendar week", last_month: "last calendar month", last_year: "last calendar year" };
  const location = scope === "delivery_area" ? "in your delivery area" : "across the store";
  return `Most units sold ${location} in completed orders ${labels[period] || labels.last_month} (UTC).`;
}
