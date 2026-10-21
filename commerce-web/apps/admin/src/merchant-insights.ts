import type { MerchantAnswer } from '@commerce/api-client';

export type MerchantInsight = { summary: string; nextStep?: string; caveat?: string };
// Summaries use only returned cells. No inferred causes, cross-currency arithmetic or hidden rows.
export function merchantInsight(answer: MerchantAnswer): MerchantInsight {
  const { rows, columns, question, currency } = answer;
  if (!rows.length) return { summary: 'No matching records for the selected filters.', nextStep: 'Check the date range and currency before widening the query.' };
  const matches = (...expected: string[]) => expected.every((name, index) => columns[index] === name);
  const count = `${answer.truncated ? 'At least ' : ''}${rows.length}`;
  const first = rows[0];
  if (question === 'orders' && matches('Status', 'Orders', 'Order value', 'Recorded refunds', 'Value less refunds') && rows.every(row => /^\d+$/.test(row[1]))) {
    const total = rows.reduce((sum, row) => sum + BigInt(row[1]), 0n);
    return { summary: `${answer.truncated ? 'The displayed statuses contain' : 'There are'} ${total} orders. ${rows.map(row => `${row[1]} ${row[0].replaceAll('_', ' ')}`).join('; ')}.`, caveat: 'Order values are booked amounts, not collected revenue. Cancelled and failed orders are listed separately.', nextStep: 'Review unfulfilled orders and failed deliveries before taking action.' };
  }
  if (question === 'top_sellers' && matches('Product ID', 'Product at order time', 'Units', 'Merchandise value')) return {
    summary: `${first[1]} ranks first with ${first[2]} ordered units and ${first[3]} ${currency} in merchandise value.`,
    caveat: 'Ordered units include unfulfilled orders. Cancelled and failed orders are excluded; item-level refunds are not deducted.',
    nextStep: 'Check current availability before promoting or replenishing these products.',
  };
  if (question === 'low_stock' && matches('Product ID', 'Product', 'SKU', 'On hand', 'Reserved', 'Available')) return {
    summary: `${count} products meet the low-stock threshold. ${first[1]} has the lowest displayed availability: ${first[5]} units.`,
    caveat: 'This is current default-stock availability, not delivery-area availability or a sales forecast.',
    nextStep: 'Review reservations and incoming stock before deciding replenishment quantities.',
  };
  if (question === 'slow_stock' && matches('Product ID', 'Product', 'Available', 'Ordered units')) return {
    summary: `${count} products meet both the high-stock and low-sales thresholds.`,
    nextStep: 'Review product visibility, pricing and stock age; this result alone does not explain slow sales.',
  };
  if (question === 'category_decline' && matches('Category ID', 'Current category', 'Previous value', 'Current value', 'Change')) return {
    summary: `${count} categories have lower merchandise value than the previous equal-length period.`,
    caveat: 'This comparison does not establish why sales changed and is not refund-adjusted net revenue.',
    nextStep: 'Compare availability and product mix before changing prices or promotions.',
  };
  if (question === 'order_status' && matches('Order ID', 'Order number', 'Status', 'Created UTC', 'Order value', 'Recorded refunds')) return {
    summary: `Order #${first[1]} is ${first[2].replaceAll('_', ' ')}. Order value: ${first[4]} ${currency}; recorded refunds: ${first[5]} ${currency}.`,
    nextStep: 'Use the order record to review fulfillment details. No changes have been made.',
  };
  return { summary: 'The verified records are shown below. Review the calculation rules before using these figures.' };
}
