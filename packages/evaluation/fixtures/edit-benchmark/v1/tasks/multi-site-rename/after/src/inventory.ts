export interface LineItem {
  sku: string;
  quantity: number;
  unitPrice: number;
}

export function computeTotal(items: LineItem[]): number {
  return items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
}

export function calcTotalWithTax(items: LineItem[], rate: number): number {
  const subtotal = computeTotal(items);
  return subtotal + subtotal * rate;
}

export function isFreeShipping(items: LineItem[]): boolean {
  return computeTotal(items) >= 50;
}
