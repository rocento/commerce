import type { DashboardReport } from '@commerce/api-client';

export function salesSeries(sales: DashboardReport['sales'], currency: string, from: string, to: string) {
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1;
  return Array.from({ length: days }, (_, i) => {
    const day = new Date(Date.parse(from) + i * 86400000).toISOString().slice(0, 10);
    const rows = sales.filter(row => row.currency === currency && row.day === day);
    return {
      day,
      orders: rows.reduce((sum, row) => sum + row.orders, 0),
      net: rows.reduce((sum, row) => sum + Number(row.net), 0),
      refunds: rows.reduce((sum, row) => sum + Number(row.refunds), 0),
    };
  });
}

export const overviewMoney = (value: number, currency: string) => new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(value);
export const overviewDate = (value: string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(value));
