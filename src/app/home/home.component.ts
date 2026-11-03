import { Component, ElementRef, HostListener, OnDestroy, OnInit } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Subscription } from 'rxjs';
import { environment } from '../../environments/environment';
import { ChartThemeService } from '../services/chart-theme.service';
import { csvCell } from '../shared/csv';
import {
  DayPoint, HomeKpis, PERIODS, PeriodKey, PeriodRange, SummaryResponse, TopSeller,
  buildKpis, dailySeries, periodRange, rangeLabel, topSellers
} from './home-data';

type LoadState = 'loading' | 'ready' | 'error';

const money0 = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 });
const money2 = new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const compact = new Intl.NumberFormat('es-MX', { notation: 'compact', maximumFractionDigits: 1 });
const intFmt = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 0 });

/**
 * Inicio: resumen de todo. KPIs, ventas vs. ganancia, más vendidos y la tabla compacta de publicaciones.
 * Es de solo lectura. Los números salen de GET /api/summary (órdenes reducidas + costo de envío) y se
 * calculan con la misma fórmula que Analytics (shared/sales-metrics).
 */
@Component({
  selector: 'app-home',
  templateUrl: './home.component.html',
  styleUrls: ['./home.component.scss']
})
export class HomeComponent implements OnInit, OnDestroy {
  readonly periods = PERIODS;
  readonly skeletonTiles = [1, 2, 3, 4, 5, 6];
  readonly skeletonRows = [1, 2, 3, 4, 5];

  periodKey: PeriodKey = '30d';
  period: PeriodRange = periodRange('30d');
  menuOpen = false;

  state: LoadState = 'loading';
  data: SummaryResponse | null = null;
  kpis: HomeKpis | null = null;
  days: DayPoint[] = [];
  top: TopSeller[] = [];
  chartOptions: any = {};

  private sub?: Subscription;
  private offTheme?: () => void;

  constructor(private http: HttpClient, private chartTheme: ChartThemeService, private host: ElementRef<HTMLElement>) {}

  ngOnInit(): void {
    this.offTheme = this.chartTheme.onChange(theme => {
      this.chartOptions = { ...this.chartOptions, theme };
      if (this.days.length) this.buildChart();
    });
    this.load();
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
    this.offTheme?.();
  }

  get periodName(): string { return PERIODS.find(p => p.key === this.periodKey)?.label ?? ''; }
  get hasOrders(): boolean { return (this.kpis?.orders ?? 0) > 0; }
  get hasChartSales(): boolean { return this.days.some(d => d.sales > 0); }
  get missing(): number { return this.data?.shippingMissing ?? 0; }
  get chartHasGaps(): boolean { return this.days.some(d => d.net === null); }

  selectPeriod(key: PeriodKey): void {
    this.menuOpen = false;
    if (key === this.periodKey) return;
    this.periodKey = key;
    this.period = periodRange(key);
    this.load();
  }

  @HostListener('document:click', ['$event'])
  onDocClick(e: Event): void {
    if (this.menuOpen && !this.host.nativeElement.querySelector('.period-wrap')?.contains(e.target as Node)) this.menuOpen = false;
  }

  load(): void {
    this.sub?.unsubscribe();
    this.state = 'loading';
    const p = this.period;
    const params = new HttpParams()
      .set('from', p.from).set('to', p.to).set('prevFrom', p.prevFrom).set('prevTo', p.prevTo)
      .set('tz', Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Mexico_City');
    this.sub = this.http.get<SummaryResponse>(`${environment.apiUrl}/summary`, { params }).subscribe({
      next: res => {
        this.data = res;
        this.kpis = buildKpis(res.orders, p);
        this.days = dailySeries(res.orders, res.range.chartFrom, p.to);
        this.top = topSellers(res.orders, p);
        this.buildChart();
        this.state = 'ready';
      },
      error: err => {
        console.error('Error loading summary:', err?.status || err?.message);
        this.state = 'error';
      }
    });
  }

  // ---------- Formato ----------
  money(v: number | null, decimals = 0): string { return v === null ? '—' : (decimals ? money2 : money0).format(v); }
  int(v: number): string { return intFmt.format(v); }
  pct1(v: number): string { return `${v > 0 ? '+' : ''}${v.toFixed(1)}%`; }
  deltaClass(v: number | null): string { return v === null || Math.abs(v) < 0.05 ? 'neutral' : v > 0 ? 'positive' : 'negative'; }
  fmtDay(day: string): string { return new Date(day + 'T12:00:00Z').toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }); }
  get chartRangeLabel(): string { return this.days.length ? rangeLabel(this.days[0].day, this.days[this.days.length - 1].day) : ''; }

  get chartLabel(): string {
    const sales = this.days.reduce((a, d) => a + d.sales, 0);
    return `Ventas brutas y ganancia neta por día, ${this.chartRangeLabel}: ${money0.format(sales)} vendidos en total.`;
  }

  private buildChart(): void {
    const fills: string[] = (this.chartTheme.current as any)?.palette?.fills ?? [];
    this.chartOptions = {
      data: this.days,
      theme: this.chartTheme.current,
      background: { fill: 'transparent' },
      padding: { top: 8, right: 4, bottom: 6, left: 0 },
      series: [
        { type: 'bar', xKey: 'label', yKey: 'sales', yName: 'Ventas brutas', strokeWidth: 0, cornerRadius: 3, fill: fills[0],
          tooltip: { renderer: (p: any) => ({ title: this.fmtDay(p.datum.day), content: money0.format(p.datum.sales) }) } },
        { type: 'bar', xKey: 'label', yKey: 'net', yName: 'Ganancia neta', strokeWidth: 0, cornerRadius: 3, fill: fills[1],
          tooltip: { renderer: (p: any) => ({ title: this.fmtDay(p.datum.day), content: money0.format(p.datum.net) }) } },
      ],
      axes: [
        { type: 'category', position: 'bottom', label: { autoRotate: false, fontSize: 11 }, gridLine: { enabled: false } },
        { type: 'number', position: 'left', label: { formatter: (p: any) => '$' + compact.format(p.value) } }
      ],
      legend: { enabled: false }
    };
  }

  // ---------- Exportar CSV (KPIs + datos diarios del período) ----------
  exportCsv(): void {
    if (!this.data || !this.kpis) return;
    const k = this.kpis;
    const num = (v: number | null, d = 2) => (v === null ? '' : Number(v.toFixed(d)));
    const lines: unknown[][] = [
      ['Período', this.period.label, this.period.from, this.period.to],
      ['Indicador', 'Valor', 'Variación vs período anterior (%)'],
      ['Ventas brutas', num(k.sales), num(k.deltaSales, 1)],
      ['Ganancia neta', num(k.net), num(k.deltaNet, 1)],
      ['Órdenes', k.orders, num(k.deltaOrders, 1)],
      ['Comisiones ML', num(k.fees), ''],
      ['Envíos', num(k.envios), ''],
      ['Retenciones SAT (2.5% ISR + 8% IVA)', num(k.sat), ''],
      [],
      ['Día', 'Ventas brutas', 'Ganancia neta', 'Órdenes'],
      ...dailySeries(this.data.orders, this.period.from, this.period.to).map(d => [d.day, num(d.sales), num(d.net), d.orders]),
    ];
    if (this.missing > 0) lines.push([], [`Faltan costos de envío de ${this.missing} órdenes: Envíos y Ganancia neta incompletos`]);
    const csv = lines.map(l => l.map(csvCell).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `inicio-${this.period.from}_${this.period.to}.csv`;
    this.host.nativeElement.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
