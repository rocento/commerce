import { useId, useState, type ReactNode } from 'react';
import { getReport, type DashboardReport } from '@commerce/api-client';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { OverviewIcon } from './overview-icon';
import { overviewDate, overviewMoney, salesSeries } from './overview-data';

function SalesChart({ days, currency }: { days: ReturnType<typeof salesSeries>; currency: string }) {
  const gradient = useId();
  const minimum = Math.min(0, ...days.map(day => day.net));
  const maximum = Math.max(1, ...days.map(day => day.net));
  const x = (i: number) => 58 + i / Math.max(1, days.length - 1) * 606;
  const y = (value: number) => 18 + (maximum - value) / (maximum - minimum) * 158;
  const line = days.map((day, i) => `${i ? 'L' : 'M'}${x(i)},${y(day.net)}`).join(' ');
  const ticks = Array.from({ length: 4 }, (_, i) => maximum - (maximum - minimum) * i / 3);
  const shortNumber = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
  return <div className="ov-chart">
    <svg viewBox="0 0 684 198" role="img" aria-label={`Daily net booked value in ${currency}, ${overviewDate(days[0].day)} to ${overviewDate(days.at(-1)!.day)}. Exact values are available in daily figures.`}>
      <defs><linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#d97757" stopOpacity=".2"/><stop offset="100%" stopColor="#d97757" stopOpacity=".01"/></linearGradient></defs>
      {ticks.map((tick, i) => <g key={i}><line x1="58" y1={y(tick)} x2="664" y2={y(tick)} stroke="#ecebe8" strokeDasharray="4 5"/><text x="45" y={y(tick) + 4} textAnchor="end">{shortNumber.format(tick)}</text></g>)}
      <path d={`${line} L${x(days.length - 1)},${y(0)} L${x(0)},${y(0)} Z`} fill={`url(#${gradient})`}/>
      <path d={line} fill="none" stroke="#cd7356" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round"/>
      {days.map((day, i) => <circle key={day.day} cx={x(i)} cy={y(day.net)} r={days.length <= 7 ? 3.5 : 2} fill="#fff" stroke="#cd7356" strokeWidth="2"><title>{overviewDate(day.day)}: {overviewMoney(day.net, currency)} · {day.orders} orders</title></circle>)}
    </svg>
    <div className="ov-chart-dates">{[0, Math.floor((days.length - 1) / 2), days.length - 1].map(i => <span key={i}>{overviewDate(days[i].day)}</span>)}</div>
  </div>;
}

function Journey({ funnel }: { funnel: DashboardReport['funnel'] }) {
  return <div className="ov-journey">
    <div className="ov-journey-heading"><h3>Shopping journey</h3><span>{funnel.visitors ? `${(funnel.purchases / funnel.visitors * 100).toFixed(1)}% visitor-to-purchase` : 'No tracked visits yet'}</span></div>
    <ol>{([['visitors', 'Visitors'], ['carts', 'Added to cart'], ['checkouts', 'Checkout'], ['purchases', 'Purchased']] as const).map(([key, label], i) => <li key={key}><span className="ov-journey-label"><i>{String(i + 1).padStart(2, '0')}</i>{label}</span><strong>{funnel[key].toLocaleString()}</strong></li>)}</ol>
    <p>Tracked sessions completing each step within the same UTC day.</p>
  </div>;
}

export function OverviewMetrics({ intelligence }: { intelligence?: ReactNode }) {
  const [period, setPeriod] = useState(7);
  const [selectedCurrency, setSelectedCurrency] = useState('');
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.parse(to) - (period - 1) * 86400000).toISOString().slice(0, 10);
  const q = useQuery({ queryKey: ['reports', from, to], queryFn: () => getReport(from, to), refetchInterval: 60000 });
  const report = q.data;
  const currencies = [...new Set(report?.sales.map(row => row.currency))].sort();
  const currency = currencies.includes(selectedCurrency) ? selectedCurrency : currencies[0];
  const days = salesSeries(report?.sales ?? [], currency ?? '', from, to);
  const orders = days.reduce((sum, day) => sum + day.orders, 0);
  const net = days.reduce((sum, day) => sum + day.net, 0);
  const refunds = days.reduce((sum, day) => sum + day.refunds, 0);
  const format = (value: number) => currency ? overviewMoney(value, currency) : '—';
  const metrics = [
    { label: 'Net booked value', value: format(net), note: 'Including delivery & tax', icon: 'chart' },
    { label: 'Valid orders', value: report ? orders.toLocaleString() : '—', note: 'Cancelled & failed excluded', icon: 'orders' },
    { label: 'Net value per order', value: orders ? format(net / orders) : '—', note: 'Average across valid orders', icon: 'value' },
    { label: 'Recorded refunds', value: format(refunds), note: 'Applied to the order date', icon: 'refund' },
  ];
  return <section className="ov-performance" aria-label="Store performance">
    <div className="ov-performance-toolbar">
      <div><h2>Performance at a glance</h2><span>{overviewDate(from)} – {overviewDate(to)} <span className="ov-separator">/</span> UTC</span></div>
      <div className="ov-performance-controls">
        {currencies.length > 1 && <select aria-label="Report currency" value={currency} onChange={event => setSelectedCurrency(event.target.value)}>{currencies.map(value => <option key={value}>{value}</option>)}</select>}
        <select aria-label="Reporting period" value={period} onChange={event => setPeriod(Number(event.target.value))}><option value={7}>Last 7 days</option><option value={30}>Last 30 days</option><option value={90}>Last 90 days</option></select>
        <button className="secondary ov-refresh" aria-label="Refresh performance" disabled={q.isFetching} onClick={() => void q.refetch()}><OverviewIcon name="refresh"/></button>
      </div>
    </div>
    {q.error && <div className="ov-report-error" role="alert">Performance data couldn’t refresh. {report ? 'The last available snapshot is shown.' : 'Use Refresh performance to try again.'} <span>{q.error.message}</span></div>}
    <div className="ov-metrics" aria-busy={q.isPending}>{metrics.map((metric, i) => <article key={metric.label} className={i === 0 ? 'ov-metric ov-metric-primary' : 'ov-metric'}><div><span>{metric.label}</span><OverviewIcon name={metric.icon}/></div><strong>{q.isPending ? <span className="ov-skeleton" aria-label="Loading"/> : metric.value}</strong><small>{metric.note}{i === 0 && currency && <b>{currency}</b>}</small></article>)}</div>
    <div className={`ov-analysis-grid${intelligence ? '' : ' ov-analysis-full'}`}>
      <section className="ov-panel ov-sales-panel" aria-labelledby="ov-sales-title">
        <div className="ov-panel-heading"><div><h2 id="ov-sales-title">Sales performance</h2><p>Net booked value{currency ? ` · ${currency}` : ''}</p></div><Link className="ov-text-link" to="/reports/dashboard">View report <OverviewIcon name="arrow"/></Link></div>
        {q.isPending ? <div className="ov-chart-placeholder" role="status">Loading recorded performance…</div> : !report ? <div className="ov-chart-placeholder">Your sales chart will appear when reporting is available.</div> : currency ? <SalesChart days={days} currency={currency}/> : <div className="ov-chart-placeholder"><OverviewIcon name="chart"/><strong>Your next chapter starts here</strong><span>Recorded orders will bring this chart to life.</span></div>}
        {report && <Journey funnel={report.funnel}/>}
        {currency && <details className="ov-daily-figures"><summary>View daily figures</summary><div className="ov-table-scroll"><table><caption>Daily recorded performance · {currency} · UTC</caption><thead><tr><th scope="col">Date</th><th scope="col">Orders</th><th scope="col">Net booked value</th><th scope="col">Refunds</th></tr></thead><tbody>{days.map(day => <tr key={day.day}><td>{overviewDate(day.day)}</td><td>{day.orders}</td><td>{format(day.net)}</td><td>{format(day.refunds)}</td></tr>)}</tbody></table></div></details>}
      </section>
      {intelligence}
    </div>
    <div className="ov-data-note"><span>Booked value reflects orders, not cash collected.</span>{report && <span className={report.run.age_seconds > 3600 ? 'ov-data-stale' : ''}>Snapshot {new Date(report.run.started_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC{report.run.age_seconds > 3600 ? ' · More than an hour old' : ''}</span>}</div>
  </section>;
}
