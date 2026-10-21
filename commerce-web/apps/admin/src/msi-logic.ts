import type { StockPoolInput } from "@commerce/api-client";

export function nextSourcePriority(stock: Pick<StockPoolInput, "sources">) {
  return stock.sources.length * 10;
}

export function setSourceAssignment(
  stock: StockPoolInput,
  source_id: string,
  assigned: boolean,
) {
  const exists = stock.sources.some((source) => source.source_id === source_id);
  if (assigned && !exists) {
    return {
      ...stock,
      sources: [
        ...stock.sources,
        { source_id, priority: nextSourcePriority(stock) },
      ],
    };
  }
  if (!assigned && exists) {
    return {
      ...stock,
      sources: stock.sources.filter((source) => source.source_id !== source_id),
    };
  }
  return stock;
}

export function setSourcePriority(
  stock: StockPoolInput,
  source_id: string,
  priority: number,
) {
  return {
    ...stock,
    sources: stock.sources.map((source) =>
      source.source_id === source_id ? { ...source, priority } : source,
    ),
  };
}

export function deductionOrder(stock: Pick<StockPoolInput, "sources">) {
  return [...stock.sources].sort((a, b) => a.priority - b.priority);
}
