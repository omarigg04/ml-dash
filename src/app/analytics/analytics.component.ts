import { Component, OnDestroy, OnInit } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { FormControl, FormGroup } from '@angular/forms';
import { Subscription, forkJoin, of } from 'rxjs';
import { catchError, map, switchMap } from 'rxjs/operators';
import { environment } from '../../environments/environment';
import { ChartThemeService } from '../services/chart-theme.service';
import { ThemeService } from '../services/theme.service';
import { SummaryResponse, rangeLabel } from '../home/home-data';
import { pctChange } from '../shared/sales-metrics';
import { ISR_RETENTION_RATE, IVA_RETENTION_RATE } from '../shared/order-math';
import {
  AItem, AItemsResponse, CmpBucket, ConvRow, Funnel, ItemAgg, KnownMetrics, MIN_PATTERN_ORDERS, MIN_RANK_VISITS,
  Pattern, PeriodKey, PeriodPair, Slice, SingleBucket, TypeRow, WINDOW_OPTIONS,
  addDays, aggregateItems, buildFunnel, buildPatterns, byListingType, compareSeries, conversionRanking, diffDays,
  metricsOf, moneyBreakdown, periodPair, rowsIn, singleSeries, ymd
} from './analytics-data';
import { TIP_THRESHOLDS, TipsResult, buildTips } from './tips';

type LoadState = 'loading' | 'ready' | 'error';

export interface Kpi {
  key: string; label: string; value: number | null; kind: 'money' | 'int';
  delta: number | null; invert?: boolean; highlight?: boolean;
}

/** Colores de series validados con el script de dataviz (adyacentes: CVD ΔE ≥ 9, visión normal ≥ 26). Claro / oscuro. */
const VIZ = {
  light: { visits: '#2a78d6', orders: '#eb6834', net: '#1baf7a', sat: '#eda100', fee: '#2a78d6', ship: '#eb6834' },
  dark: { visits: '#3987e5', orders: '#d95926', net: '#199e70', sat: '#c98500', fee: '#3987e5', ship: '#d95926' },
};

const money0 = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat('es-MX', { notation: 'compact', maximumFractionDigits: 1 });
const int0 = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 0 });

/**
 * Analytics: la versión ampliada de Inicio, centrada en gráficas, conversión y tips. Solo lectura.
 *  - Tarjetas 1 y 2 y la tira de KPIs siguen el período elegido (GET /api/summary, igual que Inicio).
 *  - Tarjetas 3 a 7 usan una ventana propia (30/60/90 días terminando hoy) porque con pocas ventas un período corto
 *    no alcanza: órdenes de /api/summary + visitas reales de GET /api/analytics/items.
 */
@Component({
  selector: 'app-analytics',
  templateUrl: './analytics.component.html',
  styleUrls: ['./analytics.component.scss']
})
export class AnalyticsComponent implements OnInit, OnDestroy {
  readonly periods: { key: PeriodKey; label: string }[] = [
    { key: '2weeks', label: '2 semanas' },
    { key: '2months', label: '2 meses' },
    { key: '2bimesters', label: '2 bimestres' },
  ];
  readonly windowOptions = WINDOW_OPTIONS;
  readonly skeletonKpis = [1, 2, 3, 4, 5, 6];
  readonly minRankVisits = MIN_RANK_VISITS;
  readonly minPatternOrders = MIN_PATTERN_ORDERS;
  readonly thresholds = TIP_THRESHOLDS;
  readonly maxDate = new Date();
  readonly tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Mexico_City';

  // ---- Período (tarjetas 1 y 2, KPIs) ----
  selectedPeriod: PeriodKey | 'custom' = '2weeks';
  customRangeForm = new FormGroup({ start: new FormControl<Date | null>(null), end: new FormControl<Date | null>(null) });
  showUnfulfilled = false;
  pair: PeriodPair = periodPair('2weeks');
  customSpan: { from: string; to: string } | null = null;
  comparison = true;
  metric: 'sales' | 'net' = 'sales';
  periodState: LoadState = 'loading';
  periodData: SummaryResponse | null = null;
  kpis: Kpi[] = [];
  curMetrics: KnownMetrics | null = null;
  breakdown: Slice[] | null = null;
  cmp: CmpBucket[] = [];
  single: { buckets: SingleBucket[]; weekly: boolean } = { buckets: [], weekly: false };
  periodChart: any = {};
  rangeError = '';

  // ---- Ventana (tarjetas 3 a 7) ----
  windowDays: number = 90;
  winState: LoadState = 'loading';
  itemsState: LoadState = 'loading';
  winData: SummaryResponse | null = null;
  itemsData: AItemsResponse | null = null;
  items: AItem[] = [];
  wFrom = '';
  wTo = '';
  funnel: Funnel | null = null;
  agg = new Map<string, ItemAgg>();
  ranking: { best: ConvRow[]; worst: ConvRow[]; eligible: number } | null = null;
  patterns: Pattern | null = null;
  types: { rows: TypeRow[]; unmatchedOrders: number } | null = null;
  tipsResult: TipsResult | null = null;
  visitsChart: any = {};
  ordersChart: any = {};
  dowChart: any = {};
  hourChart: any = {};

  private subs: Subscription[] = [];
  private winSub?: Subscription;
  private perSub?: Subscription;
  private offTheme?: () => void;

  constructor(private http: HttpClient, private chartTheme: ChartThemeService, private themeService: ThemeService) {}

  ngOnInit(): void {
    this.offTheme = this.chartTheme.onChange(() => this.rebuildCharts());
    this.selectPeriod('2weeks', true);
    this.loadWindow();
  }

  ngOnDestroy(): void {
    this.perSub?.unsubscribe();
    this.winSub?.unsubscribe();
    this.subs.forEach(s => s.unsubscribe());
    this.offTheme?.();
  }

  private get viz() { return VIZ[this.themeService.getCurrentTheme()]; }
  get periodLabel(): string {
    return this.comparison ? `${this.pair.cur.name} vs ${this.pair.prev.name}` : (this.customSpan ? rangeLabel(this.customSpan.from, this.customSpan.to) : '');
  }
  get curSpan(): { from: string; to: string } { return this.comparison ? this.pair.cur : (this.customSpan as { from: string; to: string }); }
  get shippingMissing(): number { return this.periodData ? rowsIn(this.periodData.orders, this.curSpan.from, this.curSpan.to).filter(r => r.listCost === null).length : 0; }
  get winShippingMissing(): number { return this.winData?.shippingMissing ?? 0; }

  // ---------- Período ----------
  selectPeriod(key: PeriodKey, initial = false): void {
    if (!initial && key === this.selectedPeriod && this.comparison) return;
    this.selectedPeriod = key;
    this.comparison = true;
    this.pair = periodPair(key);
    this.rangeError = '';
    this.loadPeriod();
  }

  applyCustomRange(): void {
    const { start, end } = this.customRangeForm.value;
    if (!start || !end) return;
    // El datepicker usa el adaptador de Moment: entrega Moment, no Date
    const toDate = (d: any): Date => (typeof d?.toDate === 'function' ? d.toDate() : d);
    const from = ymd(toDate(start)), to = ymd(toDate(end));
    if (from > to) { this.rangeError = 'La fecha inicial no puede ser posterior a la final.'; return; }
    if (diffDays(from, to) + 1 > 92) { this.rangeError = 'El rango máximo es de 92 días.'; return; }
    this.rangeError = '';
    this.selectedPeriod = 'custom';
    this.comparison = false;
    this.customSpan = { from, to };
    this.loadPeriod();
  }

  onUnfulfilledToggle(): void {
    this.loadPeriod();
    this.loadWindow();
  }

  retryPeriod(): void { this.loadPeriod(); }

  private summaryParams(from: string, to: string, prevFrom: string, prevTo: string): HttpParams {
    let p = new HttpParams().set('from', from).set('to', to).set('prevFrom', prevFrom).set('prevTo', prevTo).set('tz', this.tz);
    if (this.showUnfulfilled) p = p.set('includeUnfulfilled', '1');
    return p;
  }

  loadPeriod(): void {
    this.perSub?.unsubscribe();
    this.periodState = 'loading';
    const cur = this.comparison ? this.pair.cur : (this.customSpan as { from: string; to: string });
    const prev = this.comparison ? this.pair.prev : { from: addDays(cur.from, -1), to: addDays(cur.from, -1) };
    this.perSub = this.http.get<SummaryResponse>(`${environment.apiUrl}/summary`, { params: this.summaryParams(cur.from, cur.to, prev.from, prev.to) }).subscribe({
      next: res => { this.periodData = res; this.buildPeriod(); this.periodState = 'ready'; },
      error: err => { console.error('Error loading summary:', err?.status || err?.message); this.periodState = 'error'; }
    });
  }

  private buildPeriod(): void {
    const rows = this.periodData?.orders ?? [];
    const cur = this.curSpan;
    const curRows = rowsIn(rows, cur.from, cur.to);
    const m = metricsOf(curRows);
    this.curMetrics = m;
    this.breakdown = moneyBreakdown(m);
    const pm = this.comparison ? metricsOf(rowsIn(rows, this.pair.prev.from, this.pair.prev.to)) : null;
    const prevKnown = pm !== null && pm.real !== null;
    const d = (a: number | null, b: number | null | undefined) => (pm && a !== null && b != null ? pctChange(a, b) : null);
    this.kpis = [
      { key: 'sales', label: 'Ventas', value: m.sales, kind: 'money', delta: d(m.sales, pm?.sales) },
      { key: 'real', label: 'Ganancia real', value: m.real, kind: 'money', delta: prevKnown ? d(m.real, pm?.real) : null, highlight: true },
      { key: 'orders', label: 'Órdenes', value: m.count, kind: 'int', delta: d(m.count, pm?.count) },
      { key: 'units', label: 'Unidades', value: m.units, kind: 'int', delta: d(m.units, pm?.units) },
      { key: 'fees', label: 'Comisiones ML', value: m.fees, kind: 'money', delta: d(m.fees, pm?.fees), invert: true },
      { key: 'envios', label: 'Costos de envío', value: m.envios, kind: 'money', delta: m.envios !== null && pm?.envios != null ? d(m.envios, pm.envios) : null, invert: true },
    ];
    if (this.comparison) { this.cmp = compareSeries(rows, this.pair, this.metric); this.single = { buckets: [], weekly: false }; }
    else { this.single = singleSeries(rows, cur.from, cur.to); this.cmp = []; }
    this.buildPeriodChart();
  }

  setMetric(m: 'sales' | 'net'): void {
    if (m === this.metric) return;
    this.metric = m;
    if (this.periodData) this.buildPeriod();
  }

  get hasPeriodOrders(): boolean { return (this.curMetrics?.count ?? 0) > 0 || this.cmp.some(b => (b.p1 ?? 0) > 0); }
  get cmpHasGaps(): boolean { return this.metric === 'net' && this.cmp.some(b => b.p1 === null && b.p2 === null); }
  get netHasGaps(): boolean { return this.metric === 'net' && this.shippingMissing > 0; }

  // ---------- Ventana ----------
  setWindow(days: number): void {
    if (days === this.windowDays) return;
    this.windowDays = days;
    this.loadWindow();
  }

  retryWindow(): void { this.loadWindow(); }

  loadWindow(): void {
    this.winSub?.unsubscribe();
    this.winState = 'loading';
    this.itemsState = 'loading';
    const today = ymd(new Date());
    this.wTo = today;
    this.wFrom = addDays(today, -(this.windowDays - 1));
    const itemsParams = (ids?: string[]) => {
      let p = new HttpParams().set('from', this.wFrom).set('to', this.wTo);
      if (ids?.length) p = p.set('ids', ids.join(','));
      return p;
    };
    const orders$ = this.http.get<SummaryResponse>(`${environment.apiUrl}/summary`, { params: this.summaryParams(this.wFrom, this.wTo, addDays(this.wFrom, -1), addDays(this.wFrom, -1)) });
    // Publicaciones activas en paralelo con las órdenes; después se piden aparte las vendidas que ya no están activas
    const items$ = this.http.get<AItemsResponse>(`${environment.apiUrl}/analytics/items`, { params: itemsParams() });

    this.winSub = forkJoin({
      orders: orders$.pipe(catchError(() => of(null))),
      items: items$.pipe(catchError(() => of(null))),
    }).pipe(
      switchMap(({ orders, items }) => {
        const sold = new Set<string>();
        orders?.orders.forEach(r => r.order_items.forEach(i => sold.add(i.id)));
        const known = new Set(items?.items.map(i => i.id) ?? []);
        const missing = [...sold].filter(id => !known.has(id));
        if (!items || !missing.length) return of({ orders, items });
        return this.http.get<AItemsResponse>(`${environment.apiUrl}/analytics/items`, { params: itemsParams(missing) }).pipe(
          map(extra => {
            const byId = new Map(items.items.map(i => [i.id, i]));
            extra.items.forEach(i => byId.set(i.id, i));
            return { orders, items: { ...items, items: [...byId.values()], partial: items.partial || extra.partial, visitsMissing: [...byId.values()].filter(i => i.visits === null).length, meta: { ...items.meta, mlCalls: items.meta.mlCalls + extra.meta.mlCalls } } };
          }),
          catchError(() => of({ orders, items }))
        );
      })
    ).subscribe(({ orders, items }) => {
      this.winData = orders;
      this.itemsData = items;
      this.items = items?.items ?? [];
      this.winState = orders ? 'ready' : 'error';
      this.itemsState = items ? 'ready' : 'error';
      this.buildWindow();
    });
  }

  private buildWindow(): void {
    const rows = this.winData ? rowsIn(this.winData.orders, this.wFrom, this.wTo) : [];
    this.agg = aggregateItems(rows);
    this.patterns = this.winData ? buildPatterns(rows) : null;
    this.funnel = this.winData ? buildFunnel(rows, this.wFrom, this.wTo, this.itemsData?.accountDaily ?? null) : null;
    this.ranking = this.itemsData ? conversionRanking(this.items, this.agg, MIN_RANK_VISITS) : null;
    this.types = this.itemsData ? byListingType(this.agg, this.items) : null;
    this.tipsResult = this.winData && this.itemsData
      ? buildTips({ items: this.items, agg: this.agg, windowDays: this.windowDays, visitsReliable: !this.itemsData.partial, today: this.wTo })
      : null;
    this.buildWindowCharts();
  }

  // ---------- Gráficas ----------
  private rebuildCharts(): void {
    if (this.periodData) this.buildPeriodChart();
    if (this.winData) this.buildWindowCharts();
  }

  private buildPeriodChart(): void {
    const fills: string[] = (this.chartTheme.current as any)?.palette?.fills ?? [];
    const yAxis = { type: 'number', position: 'left', label: { formatter: (p: any) => '$' + compact.format(p.value) } };
    if (this.comparison) {
      const tip = (key: 'p1' | 'p2') => ({ renderer: (p: any) => ({ title: p.datum.label, content: p.datum[key] === null ? 'Sin dato de envío' : money0.format(p.datum[key]) }) });
      this.periodChart = {
        data: this.cmp, theme: this.chartTheme.current, background: { fill: 'transparent' },
        padding: { top: 8, right: 8, bottom: 6, left: 0 },
        series: [
          { type: 'bar', xKey: 'label', yKey: 'p1', yName: this.pair.prev.name, strokeWidth: 0, cornerRadius: 3, fill: fills[0], tooltip: tip('p1') },
          { type: 'bar', xKey: 'label', yKey: 'p2', yName: this.pair.cur.name, strokeWidth: 0, cornerRadius: 3, fill: fills[1], tooltip: tip('p2') },
        ],
        axes: [{ type: 'category', position: 'bottom', label: { autoRotate: true, fontSize: 11 }, gridLine: { enabled: false } }, yAxis],
        legend: { enabled: true, position: 'bottom' },
      };
      return;
    }
    const tip = (key: 'sales' | 'net') => ({ renderer: (p: any) => ({ title: p.datum.label, content: p.datum[key] === null ? 'Sin dato de envío' : money0.format(p.datum[key]) }) });
    this.periodChart = {
      data: this.single.buckets, theme: this.chartTheme.current, background: { fill: 'transparent' },
      padding: { top: 8, right: 8, bottom: 6, left: 0 },
      series: [
        { type: 'bar', xKey: 'label', yKey: 'sales', yName: 'Ventas', strokeWidth: 0, cornerRadius: 3, fill: fills[0], tooltip: tip('sales') },
        { type: 'bar', xKey: 'label', yKey: 'net', yName: 'Ganancia real', strokeWidth: 0, cornerRadius: 3, fill: fills[1], tooltip: tip('net') },
      ],
      axes: [{ type: 'category', position: 'bottom', label: { autoRotate: true, fontSize: 11 }, gridLine: { enabled: false } }, yAxis],
      legend: { enabled: true, position: 'bottom' },
    };
  }

  private smallBars(data: any[], xKey: string, yKey: string, yName: string, color: string, unit: string, opts: { height?: number; step?: number } = {}): any {
    const max = Math.max(0, ...data.map(d => d[yKey] as number));
    return {
      data, theme: this.chartTheme.current, background: { fill: 'transparent' },
      padding: { top: 6, right: 8, bottom: 4, left: 0 },
      series: [{
        type: 'bar', xKey, yKey, yName, fill: color, strokeWidth: 0, cornerRadius: 2,
        tooltip: { renderer: (p: any) => ({ title: p.datum.tipTitle || p.datum[xKey], content: `${int0.format(p.datum[yKey])} ${unit}` }) }
      }],
      axes: [
        { type: 'category', position: 'bottom', label: { autoRotate: false, fontSize: 11 }, gridLine: { enabled: false } },
        { type: 'number', position: 'left', min: 0, ...(max <= 5 ? { tick: { interval: 1 } } : {}), label: { formatter: (p: any) => compact.format(p.value) } },
      ],
      legend: { enabled: false },
    };
  }

  private buildWindowCharts(): void {
    const c = this.viz;
    if (this.funnel) {
      const days = this.funnel.days.map(d => ({ ...d, tipTitle: this.fmtDay(d.day) }));
      this.visitsChart = this.smallBars(days, 'label', 'visits', 'Visitas', c.visits, 'visitas');
      this.ordersChart = this.smallBars(days, 'label', 'orders', 'Órdenes', c.orders, 'órdenes');
    }
    if (this.patterns) {
      this.dowChart = this.smallBars(this.patterns.byDow, 'label', 'orders', 'Órdenes', c.orders, 'órdenes');
      this.hourChart = this.smallBars(this.patterns.byHour, 'label', 'orders', 'Órdenes', c.orders, 'órdenes');
    }
  }

  // ---------- Formato ----------
  money(v: number | null): string { return v === null ? '—' : money0.format(v); }
  int(v: number | null): string { return v === null ? '—' : int0.format(v); }
  pct(v: number | null, digits = 1): string { return v === null ? '—' : `${v.toLocaleString('es-MX', { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`; }
  pct1(v: number): string { return `${v > 0 ? '+' : ''}${v.toFixed(1)}%`; }
  rate(v: number | null): string { return v === null ? '—' : this.pct(v * 100, v < 0.1 ? 2 : 1); }
  fmtDay(day: string): string { return new Date(day + 'T12:00:00Z').toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }); }
  deltaClass(k: Kpi): string {
    if (k.delta === null || Math.abs(k.delta) < 0.05) return 'neutral';
    return (k.invert ? k.delta < 0 : k.delta > 0) ? 'positive' : 'negative';
  }
  sliceVar(s: Slice): string { return `var(--v-${s.key})`; }
  barWidth(v: number, max: number): number { return max > 0 ? Math.max(4, Math.round((v / max) * 100)) : 0; }
  maxConv(rows: ConvRow[]): number { return Math.max(0, ...rows.map(r => r.conversion)); }
  get windowLabel(): string { return this.wFrom ? rangeLabel(this.wFrom, this.wTo) : ''; }
  get smallSample(): boolean { return (this.patterns?.n ?? 0) < MIN_PATTERN_ORDERS; }
  get visitsPartial(): boolean { return !!this.itemsData && (this.itemsData.accountDaily === null || this.itemsData.visitsMissing > 0); }
  get satNote(): string { return `${(ISR_RETENTION_RATE * 100).toFixed(1)}% ISR + ${(IVA_RETENTION_RATE * 100).toFixed(0)}% IVA sobre el precio sin IVA`; }
  get maxTypeRevenue(): number { return Math.max(0, ...(this.types?.rows.map(r => r.revenue) ?? [0])); }
  get breakdownLabel(): string {
    return 'Desglose de las ventas: ' + (this.breakdown ?? []).map(s => s.label + ' ' + (s.pct === null ? 'sin dato' : this.pct(s.pct))).join(', ');
  }

  trackById(_: number, x: { id: string }): string { return x.id; }

}
