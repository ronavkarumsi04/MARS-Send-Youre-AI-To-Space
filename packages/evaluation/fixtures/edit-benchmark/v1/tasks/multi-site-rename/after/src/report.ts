import { computeTotal, type LineItem } from "./inventory";

export function renderReceipt(items: LineItem[]): string {
  const lines = items.map((item) => `${item.sku} x${item.quantity}`);
  lines.push(`total: ${computeTotal(items).toFixed(2)}`);
  return lines.join("\n");
}
