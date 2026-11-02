import { Component, OnDestroy, OnInit } from '@angular/core';
import { ChartThemeService } from '../services/chart-theme.service';
import { HttpClient, HttpParams } from '@angular/common/http';
import { FormGroup, FormControl } from '@angular/forms';
import { Order } from '../interfaces/Order.interface';
import { DatePipe } from '@angular/common';
import { forkJoin, of } from 'rxjs';
import { catchError, map, mergeMap } from 'rxjs/operators';
import { environment } from '../../environments/environment';
import { orderSaleFee, satRetention } from '../shared/order-math';

interface Publication {
  id: string;
  title: string;
  price: number;
  available_quantity: number;
  sold_quantity?: number;
  status: string;
  thumbnail: string | null;
  listing_type_id: string;
  condition: string;
  permalink: string;
}

interface Metrics {
  sales: number;
  fees: number;
  envios: number;
  real: number;
  count: number;
  units: number;
}

export interface Kpi {
  key: string;
  label: string;
  value: number;
  kind: 'money' | 'int';
  /** Variación % vs período anterior (null si no hay base o no es modo comparación) */
  delta: number | null;
  /** true si subir es malo (comisiones, envíos) */
  invert?: boolean;
  highlight?: boolean;
}

@Component({
  selector: 'app-bar-chart',
  templateUrl: './bar-chart.component.html',
  styleUrls: ['./bar-chart.component.scss'],
})
export class BarChartComponent implements OnInit, OnDestroy {
  private offChartTheme?: () => void;
  isLoading: boolean = true;
  totalSumIsLoading: boolean = true;
  enviosIsLoading: boolean = true;
  feesIsLoading: boolean = true;
  satSumIsLoading: boolean = true;
  realSumIsLoading: boolean = true;

  public totalSum: number = 0;
  public envios: number = 0;
  public fees: number = 0;
  public satSum: number = 0;
  public realSum: number = 0;
  public options: any = {};
  public chartData: any[] = [];
  public filteredChartData: any[] = [];
  public ordersWithShippingCost: Order[] = [];

  // Variables para porcentajes de cambio
  public totalSumChangePercent: number = 0;
  public realSumChangePercent: number = 0;
  public totalSumChangeIcon: string = 'trending_flat';
  public realSumChangeIcon: string = 'trending_flat';
  dateRangeForm: FormGroup;
  customRangeForm: FormGroup; // FormGroup para el date range picker según documentación
  maxDate: Date = new Date(); // Fecha máxima: hoy
  selectedStartDate: Date | null = null;
  selectedEndDate: Date | null = null;
  selectedPeriod: string = '2weeks'; // Valor por defecto (28 días)
  customStartDate: Date | null = null;
  customEndDate: Date | null = null;
  showUnfulfilled: boolean = false; // Controla si se muestran órdenes con fulfilled: false
  isComparisonMode: boolean = true; // true = comparación, false = rango único

  // Estados de error (A2) y KPIs de la tira
  readonly periods = [
    { key: '2weeks', label: '2 semanas' },
    { key: '2months', label: '2 meses' },
    { key: '2bimesters', label: '2 bimestres' },
  ];
  readonly skeletonKpis: Kpi[] = ['Ventas', 'Ganancia real', 'Órdenes', 'Unidades', 'Comisiones ML', 'Costos de envío']
    .map((label, i) => ({ key: 's' + i, label, value: 0, kind: 'int' as const, delta: null }));
  ordersError = false;
  productsError = false;
  hasOrders = true;
  kpis: Kpi[] = [];
  periodLabel = '';

  // Product lists
  recentProducts: Publication[] = [];
  topSellingProducts: Publication[] = [];
  productsLoading: boolean = true;

  constructor(private http: HttpClient, private datePipe: DatePipe, private chartTheme: ChartThemeService) {
    // Re-aplica el tema de la gráfica cuando cambia claro/oscuro
    this.offChartTheme = this.chartTheme.onChange(theme => {
      this.options = { ...this.options, theme };
    });

    this.dateRangeForm = new FormGroup({
      start: new FormControl(),
      end: new FormControl(),
    });

    // FormGroup para el date range picker según documentación oficial
    this.customRangeForm = new FormGroup({
      start: new FormControl<Date | null>(null),
      end: new FormControl<Date | null>(null),
    });
  }

  ngOnInit(): void {
    // Por defecto: cargar últimas 2 semanas
    this.onPeriodChange('2weeks');
    // Cargar publicaciones
    this.loadPublications();
  }

  /**
   * Carga publicaciones y las divide en recientes y más vendidas
   */
  loadPublications(): void {
    this.productsLoading = true;
    this.productsError = false;

    const mostSoldParams = new HttpParams()
      .set('sort', 'sales_desc')
      .set('limit', '4')
      .set('status', 'active');

    const recentlyCreatedParams = new HttpParams()
      .set('sort', 'date_desc')
      .set('limit', '4')
      .set('status', 'active');

    const mostSoldRequest = this.http.get<{items: Publication[]}>(`${environment.apiUrl}/items`, { params: mostSoldParams });
    const recentlyCreatedRequest = this.http.get<{items: Publication[]}>(`${environment.apiUrl}/items`, { params: recentlyCreatedParams });

    forkJoin({
      mostSold: mostSoldRequest,
      recentlyCreated: recentlyCreatedRequest
    }).subscribe({
      next: ({ mostSold, recentlyCreated }) => {
        this.topSellingProducts = mostSold.items.filter(p => (p.sold_quantity || 0) > 0);
        this.recentProducts = recentlyCreated.items;
        this.productsLoading = false;
      },
      error: (error) => {
        console.error('Error al cargar publicaciones:', error);
        this.productsError = true;
        this.productsLoading = false;
      }
    });
  }

  /**
   * Carga órdenes del backend con filtrado por rango de fechas
   */
  loadOrders(from: Date, to: Date): void {
    this.isLoading = true;
    this.ordersError = false;
    this.totalSumIsLoading = this.feesIsLoading = this.enviosIsLoading = this.satSumIsLoading = this.realSumIsLoading = true;
    this.lastRange = { from, to };

    // Formatear fechas a ISO 8601
    const fromISO = from.toISOString();
    const toISO = to.toISOString();

    console.log(`📅 Loading orders from ${fromISO} to ${toISO}`);

    this.http.get<Order[]>(`${environment.apiUrl}/orders`, {
      params: {
        from: fromISO,
        to: toISO
      }
    }).pipe(
      map(orders => orders.filter(order => {
        // Mostrar siempre órdenes con fulfilled: true o null
        // Mostrar fulfilled: false solo si showUnfulfilled está activado
        return order.fulfilled !== false || this.showUnfulfilled;
      })),
      mergeMap(fulfilledOrders => {
        this.chartData = fulfilledOrders.map(order => {
          const date = new Date(order.date_created);
          const saleFee = orderSaleFee(order);

          return { date, total_amount: order.total_amount, saleFee };
        });

        const shipmentCostRequests = fulfilledOrders.map(order =>
          this.http.get<{ listCost: number }>(`${environment.apiUrl}/shipments/${order.shipping.id}`).pipe(
            catchError(() => of({ listCost: 0 }))
          )
        );

        // forkJoin([]) completa sin emitir: sin órdenes el spinner quedaba infinito
        if (shipmentCostRequests.length === 0) return of([] as Order[]);

        return forkJoin(shipmentCostRequests).pipe(
          map(listCosts => {
            return fulfilledOrders.map((order, index) => ({
              ...order,
              listCost: listCosts[index].listCost
            })) as Order[];
          })
        );
      })
    ).subscribe({
      next: (ordersWithShippingCost: Order[]) => {
        this.ordersWithShippingCost = ordersWithShippingCost;
        this.envios = ordersWithShippingCost.reduce((acc, order) => acc + order.listCost, 0);
        this.filteredChartData = this.chartData;
        this.updateChart();
        this.isLoading = false;
        this.enviosIsLoading = false;
      },
      error: error => {
        console.error('Error al obtener pedidos:', error);
        this.ordersError = true;
        this.isLoading = false;
        this.totalSumIsLoading = this.feesIsLoading = this.enviosIsLoading = this.satSumIsLoading = this.realSumIsLoading = false;
      }
    });
  }

  private lastRange: { from: Date; to: Date } | null = null;

  /** Botón "Reintentar" de KPIs y gráfica */
  retryOrders(): void {
    if (this.lastRange) this.loadOrders(this.lastRange.from, this.lastRange.to);
    else this.onPeriodChange(this.selectedPeriod === 'custom' ? '2weeks' : this.selectedPeriod);
  }

  private metrics(orders: Order[]): Metrics {
    const sales = orders.reduce((acc, o) => acc + o.total_amount, 0);
    const fees = orders.reduce((acc, o) => acc + orderSaleFee(o), 0);
    const envios = orders.reduce((acc, o) => acc + o.listCost, 0);
    const real = sales - (satRetention(sales) + envios + fees);
    const units = orders.reduce((acc, o) => acc + o.order_items.reduce((sum, item) => sum + item.quantity, 0), 0);
    return { sales, fees, envios, real, count: orders.length, units };
  }

  private ordersBetween(orders: Order[], start: Date, end: Date): Order[] {
    const s0 = this.normalizeToStartOfDay(start).getTime();
    const e0 = this.normalizeToStartOfDay(end).getTime();
    return orders.filter(o => {
      const d = this.normalizeToStartOfDay(new Date(o.date_created)).getTime();
      return d >= s0 && d <= e0;
    });
  }

  private pct(cur: number, prev: number): number | null {
    return prev > 0 ? ((cur - prev) / prev) * 100 : null;
  }

  /**
   * Construye la tira de KPIs. En modo comparación los valores son los del período actual
   * (período 2) y el delta es contra el período anterior (período 1); en rango personalizado
   * son los del rango completo, sin delta.
   */
  private buildKpis(allOrders: Order[]): void {
    const p1s: Date = (this as any).period1Start, p1e: Date = (this as any).period1End;
    const p2s: Date = (this as any).period2Start, p2e: Date = (this as any).period2End;
    const compare = this.isComparisonMode && !!p1s && !!p2s;

    const cur = this.metrics(compare ? this.ordersBetween(allOrders, p2s, p2e) : allOrders);
    const prev = compare ? this.metrics(this.ordersBetween(allOrders, p1s, p1e)) : null;
    const d = (k: keyof Metrics) => (prev ? this.pct(cur[k], prev[k]) : null);

    this.totalSum = cur.sales;
    this.fees = cur.fees;
    this.envios = cur.envios;
    this.satSum = satRetention(cur.sales);
    this.realSum = cur.real;
    this.hasOrders = allOrders.length > 0;
    this.periodLabel = compare
      ? `${(this as any).period2Name} vs ${(this as any).period1Name}`
      : ((this as any).customRangeName || '');

    this.kpis = [
      { key: 'sales', label: 'Ventas', value: cur.sales, kind: 'money', delta: d('sales') },
      { key: 'real', label: 'Ganancia real', value: cur.real, kind: 'money', delta: d('real'), highlight: true },
      { key: 'orders', label: 'Órdenes', value: cur.count, kind: 'int', delta: d('count') },
      { key: 'units', label: 'Unidades', value: cur.units, kind: 'int', delta: d('units') },
      { key: 'fees', label: 'Comisiones ML', value: cur.fees, kind: 'money', delta: d('fees'), invert: true },
      { key: 'envios', label: 'Costos de envío', value: cur.envios, kind: 'money', delta: d('envios'), invert: true },
    ];
  }

  deltaClass(k: Kpi): string {
    if (k.delta === null || Math.abs(k.delta) < 0.05) return 'neutral';
    const good = k.invert ? k.delta < 0 : k.delta > 0;
    return good ? 'positive' : 'negative';
  }

  /**
   * Normaliza una fecha al inicio del día (00:00:00.000)
   */
  private normalizeToStartOfDay(date: Date): Date {
    const normalized = new Date(date);
    normalized.setHours(0, 0, 0, 0);
    return normalized;
  }

  /**
   * Normaliza una fecha al final del día (23:59:59.999)
   */
  private normalizeToEndOfDay(date: Date): Date {
    const normalized = new Date(date);
    normalized.setHours(23, 59, 59, 999);
    return normalized;
  }

  onPeriodChange(period: string) {
    // Activar modo comparación
    this.isComparisonMode = true;

    const now = new Date();
    let period1Start: Date, period1End: Date, period2Start: Date, period2End: Date;
    let period1Name: string, period2Name: string;

    switch (period) {
      case '2weeks':
        // Período 2: últimos 7 días (esta semana)
        period2End = new Date(now);
        period2Start = new Date(now);
        period2Start.setDate(period2Start.getDate() - 6); // 7 días incluyendo hoy

        // Período 1: 7 días anteriores (semana pasada)
        period1End = new Date(period2Start);
        period1End.setDate(period1End.getDate() - 1);
        period1Start = new Date(period1End);
        period1Start.setDate(period1Start.getDate() - 6); // 7 días

        // Normalizar fechas
        period1Start = this.normalizeToStartOfDay(period1Start);
        period1End = this.normalizeToEndOfDay(period1End);
        period2Start = this.normalizeToStartOfDay(period2Start);
        period2End = this.normalizeToEndOfDay(period2End);

        period1Name = 'Semana pasada';
        period2Name = 'Esta semana';
        break;

      case '2months':
        // Siempre mostrar los 2 meses COMPLETOS más recientes
        // Período 2: mes anterior completo
        const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        period2Start = new Date(lastMonth.getFullYear(), lastMonth.getMonth(), 1);
        period2End = new Date(now.getFullYear(), now.getMonth(), 0); // Último día del mes anterior

        // Período 1: mes antepasado completo
        const twoMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 2, 1);
        period1Start = new Date(twoMonthsAgo.getFullYear(), twoMonthsAgo.getMonth(), 1);
        period1End = new Date(lastMonth.getFullYear(), lastMonth.getMonth(), 0); // Último día del mes antepasado

        // Normalizar fechas
        period1Start = this.normalizeToStartOfDay(period1Start);
        period1End = this.normalizeToEndOfDay(period1End);
        period2Start = this.normalizeToStartOfDay(period2Start);
        period2End = this.normalizeToEndOfDay(period2End);

        const lastMonthName = lastMonth.toLocaleString('es-MX', { month: 'long' });
        const twoMonthsAgoName = twoMonthsAgo.toLocaleString('es-MX', { month: 'long' });

        period1Name = twoMonthsAgoName.charAt(0).toUpperCase() + twoMonthsAgoName.slice(1);
        period2Name = lastMonthName.charAt(0).toUpperCase() + lastMonthName.slice(1);
        break;

      case '2bimesters':
        // Siempre mostrar los 2 bimestres COMPLETOS más recientes
        // Para esto, retrocedemos 1 bimestre desde hoy y luego tomamos ese y el anterior

        const currentBimester = Math.floor(now.getMonth() / 2); // 0-5 (6 bimestres al año)
        let year2 = now.getFullYear();
        let bimester2 = currentBimester - 1; // Bimestre anterior completo

        // Si el bimestre anterior está en el año pasado
        if (bimester2 < 0) {
          bimester2 = 5; // Nov-Dic
          year2 = now.getFullYear() - 1;
        }

        // Período 2: bimestre anterior completo
        period2Start = new Date(year2, bimester2 * 2, 1);
        period2End = new Date(year2, (bimester2 * 2) + 2, 0); // Último día del bimestre

        // Período 1: bimestre anterior al período 2
        let year1 = year2;
        let bimester1 = bimester2 - 1;

        if (bimester1 < 0) {
          bimester1 = 5; // Nov-Dic
          year1 = year2 - 1;
        }

        period1Start = new Date(year1, bimester1 * 2, 1);
        period1End = new Date(year1, (bimester1 * 2) + 2, 0);

        // Normalizar fechas
        period1Start = this.normalizeToStartOfDay(period1Start);
        period1End = this.normalizeToEndOfDay(period1End);
        period2Start = this.normalizeToStartOfDay(period2Start);
        period2End = this.normalizeToEndOfDay(period2End);

        const getBimesterName = (date: Date) => {
          const month = date.getMonth();
          const bimester = Math.floor(month / 2);
          const months = ['Ene-Feb', 'Mar-Abr', 'May-Jun', 'Jul-Ago', 'Sep-Oct', 'Nov-Dic'];
          return months[bimester];
        };

        period1Name = getBimesterName(period1Start);
        period2Name = getBimesterName(period2Start);
        break;

      case 'custom':
        // No hacer nada, esperar a que el usuario aplique el rango personalizado
        return;

      default:
        return;
    }

    // Guardar períodos calculados para usarlos en prepareTwoMonthsComparison
    this.selectedStartDate = period1Start;
    this.selectedEndDate = period2End;
    this.selectedPeriod = period;

    // Guardar nombres de períodos (los usaremos en updateChart)
    (this as any).period1Start = period1Start;
    (this as any).period1End = period1End;
    (this as any).period2Start = period2Start;
    (this as any).period2End = period2End;
    (this as any).period1Name = period1Name;
    (this as any).period2Name = period2Name;

    // Calcular rango completo para la API (desde period1Start hasta period2End)
    const rangeStart = period1Start;
    const rangeEnd = period2End;

    console.log(`📊 Período seleccionado: ${period}`);
    console.log(`  📅 Período 1 (${period1Name}): ${period1Start.toLocaleDateString()} - ${period1End.toLocaleDateString()}`);
    console.log(`  📅 Período 2 (${period2Name}): ${period2Start.toLocaleDateString()} - ${period2End.toLocaleDateString()}`);
    console.log(`  🌐 API Range: ${rangeStart.toLocaleDateString()} - ${rangeEnd.toLocaleDateString()}`);

    // Cargar órdenes del rango completo
    this.loadOrders(rangeStart, rangeEnd);
  }

  applyCustomRange() {
    const startDate = this.customRangeForm.value.start;
    const endDate = this.customRangeForm.value.end;

    if (startDate && endDate) {
      // Normalizar fechas de entrada
      const normalizedStartDate = this.normalizeToStartOfDay(startDate);
      const normalizedEndDate = this.normalizeToEndOfDay(endDate);

      // Validar que el rango no sea mayor a 1 año
      const diffTime = Math.abs(normalizedEndDate.getTime() - normalizedStartDate.getTime());
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

      if (diffDays > 365) {
        alert('El rango seleccionado no puede ser mayor a 365 días');
        return;
      }

      // Modo rango único: mostrar todo el rango sin dividir
      this.isComparisonMode = false;
      this.selectedPeriod = 'custom';
      this.selectedStartDate = normalizedStartDate;
      this.selectedEndDate = normalizedEndDate;

      // Guardar el rango como un solo período
      const formatDate = (date: Date) => date.toLocaleDateString('es-MX', { month: 'short', day: 'numeric', year: 'numeric' });
      const rangeName = `${formatDate(normalizedStartDate)} - ${formatDate(normalizedEndDate)}`;

      (this as any).customRangeStart = normalizedStartDate;
      (this as any).customRangeEnd = normalizedEndDate;
      (this as any).customRangeName = rangeName;

      console.log(`📊 Rango personalizado aplicado (sin comparación)`);
      console.log(`  📅 Rango: ${normalizedStartDate.toLocaleDateString()} - ${normalizedEndDate.toLocaleDateString()}`);

      // Cargar órdenes del rango completo
      this.loadOrders(normalizedStartDate, normalizedEndDate);
    }
  }

  resetFilter() {
    this.selectedPeriod = '2weeks';
    this.customStartDate = null;
    this.customEndDate = null;
    this.selectedStartDate = null;
    this.selectedEndDate = null;
    this.updateChart();
  }

  /**
   * Maneja el cambio del checkbox de órdenes no cumplidas
   */
  onUnfulfilledToggle() {
    console.log(`📊 Checkbox órdenes no cumplidas: ${this.showUnfulfilled}`);

    // Recargar datos con el nuevo filtro
    if (this.selectedStartDate && this.selectedEndDate) {
      const rangeStart = (this as any).period1Start || this.selectedStartDate;
      const rangeEnd = (this as any).period2End || this.selectedEndDate;
      this.loadOrders(rangeStart, rangeEnd);
    }
  }

  /**
   * Genera un array con todas las fechas entre startDate y endDate
   */
  private generateDateRange(startDate: Date, endDate: Date): Date[] {
    const dates: Date[] = [];
    const currentDate = new Date(startDate);

    while (currentDate <= endDate) {
      dates.push(new Date(currentDate));
      currentDate.setDate(currentDate.getDate() + 1);
    }

    return dates;
  }

  private aggregateDataByDate(data: any[]): any[] {
    const aggregatedData = new Map<string, { total_amount: number, sale_fee: number, dateObj: Date }>();

    data.forEach(({ date, total_amount, sale_fee }) => {
      const dateKey = this.datePipe.transform(date, 'MM-dd-yyyy');
      if (!dateKey) return;

      if (aggregatedData.has(dateKey)) {
        const existing = aggregatedData.get(dateKey)!;
        existing.total_amount += total_amount;
        existing.sale_fee += sale_fee;
      } else {
        aggregatedData.set(dateKey, { total_amount: total_amount, sale_fee: sale_fee, dateObj: new Date(date) });
      }
    });

    // Convertir a array y ordenar por fecha ascendente
    return Array.from(aggregatedData, ([dateKey, { total_amount, sale_fee, dateObj }]) => ({
      date: dateObj,
      total_amount,
      sale_fee
    })).sort((a, b) => a.date.getTime() - b.date.getTime());
  }

  // Prepara datos para rango único (sin comparación)
  private prepareSingleRange(filteredOrders: Order[] = this.ordersWithShippingCost): any[] {
    const rangeStart: Date = (this as any).customRangeStart;
    const rangeEnd: Date = (this as any).customRangeEnd;

    if (!rangeStart || !rangeEnd) {
      console.warn('⚠️ No hay rango definido');
      return [];
    }

    // Convertir órdenes a formato de datos
    const filteredChartData = filteredOrders.map(order => {
      const date = new Date(order.date_created);
      return { date, total_amount: order.total_amount };
    });

    // Normalizar fechas
    const normalizeDateToMidnight = (date: Date): Date => {
      const normalized = new Date(date);
      normalized.setHours(0, 0, 0, 0);
      return normalized;
    };

    const rStart = normalizeDateToMidnight(rangeStart);
    const rEnd = normalizeDateToMidnight(rangeEnd);

    // Agrupar por día
    const dayMap = new Map<string, number>();

    // Generar todos los días del rango
    const currentDate = new Date(rStart);
    while (currentDate <= rEnd) {
      const dateKey = this.datePipe.transform(currentDate, 'yyyy-MM-dd');
      if (dateKey) {
        dayMap.set(dateKey, 0);
      }
      currentDate.setDate(currentDate.getDate() + 1);
    }

    // Agregar ventas a cada día
    filteredChartData.forEach(item => {
      const normalizedDate = normalizeDateToMidnight(item.date);
      if (normalizedDate >= rStart && normalizedDate <= rEnd) {
        const dateKey = this.datePipe.transform(normalizedDate, 'yyyy-MM-dd');
        if (dateKey && dayMap.has(dateKey)) {
          dayMap.set(dateKey, dayMap.get(dateKey)! + item.total_amount);
        }
      }
    });

    // Convertir a array
    const result: any[] = [];
    dayMap.forEach((amount, dateKey) => {
      const date = new Date(dateKey);
      const label = this.datePipe.transform(date, 'd MMM', 'es-MX') || dateKey;
      result.push({
        day: label,
        sales: amount,
        dateKey
      });
    });

    return result.sort((a, b) => a.dateKey.localeCompare(b.dateKey));
  }

  // Prepara datos para comparación de períodos (dinámico con agrupación)
  private prepareTwoMonthsComparison(filteredOrders: Order[] = this.ordersWithShippingCost): any[] {
    // Convertir filteredOrders a formato chartData
    const filteredChartData = filteredOrders.map(order => {
      const date = new Date(order.date_created);
      const saleFee = orderSaleFee(order);
      return { date, total_amount: order.total_amount, saleFee };
    });

    // Usar períodos calculados en onPeriodChange o applyCustomRange
    const period1Start: Date = (this as any).period1Start;
    const period1End: Date = (this as any).period1End;
    const period2Start: Date = (this as any).period2Start;
    const period2End: Date = (this as any).period2End;
    const period1Name: string = (this as any).period1Name || 'Período 1';
    const period2Name: string = (this as any).period2Name || 'Período 2';

    // Determinar agrupación según el período
    let groupBy: 'day' | 'week' | 'month' = 'day';
    if (this.selectedPeriod === '2bimesters') {
      groupBy = 'week';
    }

    // Si no hay períodos guardados, retornar array vacío
    if (!period1Start || !period2Start) {
      console.warn('⚠️ No hay períodos definidos para la comparación');
      return [];
    }

    // Calcular el número de días en cada período
    const period1Days = Math.ceil((period1End.getTime() - period1Start.getTime()) / (1000 * 60 * 60 * 24)) + 1;
    const period2Days = Math.ceil((period2End.getTime() - period2Start.getTime()) / (1000 * 60 * 60 * 24)) + 1;

    console.log(`📊 Preparando comparación traslapada (${groupBy}):`);
    console.log(`  Período 1: ${period1Days} días`);
    console.log(`  Período 2: ${period2Days} días`);

    // Crear mapa según la agrupación
    let dataMap: Map<number, { period1: number, period2: number }>;
    let maxUnits: number;

    if (groupBy === 'week') {
      // Agrupar por semanas (7 días)
      const period1Weeks = Math.ceil(period1Days / 7);
      const period2Weeks = Math.ceil(period2Days / 7);
      maxUnits = Math.max(period1Weeks, period2Weeks);
      dataMap = new Map<number, { period1: number, period2: number }>();

      // Inicializar todas las semanas con $0
      for (let i = 1; i <= maxUnits; i++) {
        dataMap.set(i, { period1: 0, period2: 0 });
      }
      console.log(`  Semanas máximas: ${maxUnits}`);
    } else {
      // Agrupar por días
      maxUnits = Math.max(period1Days, period2Days);
      dataMap = new Map<number, { period1: number, period2: number }>();

      // Inicializar todos los días con $0
      for (let i = 1; i <= maxUnits; i++) {
        dataMap.set(i, { period1: 0, period2: 0 });
      }
      console.log(`  Días máximos: ${maxUnits}`);
    }

    // Normalizar fechas a medianoche para comparación correcta
    const normalizeDateToMidnight = (date: Date): Date => {
      const normalized = new Date(date);
      normalized.setHours(0, 0, 0, 0);
      return normalized;
    };

    // Normalizar períodos a medianoche
    const p1Start = normalizeDateToMidnight(period1Start);
    const p1End = normalizeDateToMidnight(period1End);
    const p2Start = normalizeDateToMidnight(period2Start);
    const p2End = normalizeDateToMidnight(period2End);

    // Procesar datos del período 1
    filteredChartData.forEach(item => {
      const orderDate = new Date(item.date);
      const normalizedDate = normalizeDateToMidnight(orderDate);

      if (normalizedDate >= p1Start && normalizedDate <= p1End) {
        // Calcular día relativo (1-based)
        const dayDiff = Math.floor((normalizedDate.getTime() - p1Start.getTime()) / (1000 * 60 * 60 * 24));
        const relativeDay = dayDiff + 1;

        // Si agrupamos por semana, calcular la semana relativa
        const relativeUnit = groupBy === 'week' ? Math.ceil(relativeDay / 7) : relativeDay;

        if (dataMap.has(relativeUnit)) {
          dataMap.get(relativeUnit)!.period1 += item.total_amount;
          const unitLabel = groupBy === 'week' ? `Semana ${relativeUnit}` : `Día ${relativeUnit}`;
          console.log(`📅 P1 - ${unitLabel}: +$${item.total_amount} (fecha: ${orderDate.toLocaleDateString()})`);
        }
      }
    });

    // Procesar datos del período 2
    filteredChartData.forEach(item => {
      const orderDate = new Date(item.date);
      const normalizedDate = normalizeDateToMidnight(orderDate);

      if (normalizedDate >= p2Start && normalizedDate <= p2End) {
        // Calcular día relativo (1-based)
        const dayDiff = Math.floor((normalizedDate.getTime() - p2Start.getTime()) / (1000 * 60 * 60 * 24));
        const relativeDay = dayDiff + 1;

        // Si agrupamos por semana, calcular la semana relativa
        const relativeUnit = groupBy === 'week' ? Math.ceil(relativeDay / 7) : relativeDay;

        if (dataMap.has(relativeUnit)) {
          dataMap.get(relativeUnit)!.period2 += item.total_amount;
          const unitLabel = groupBy === 'week' ? `Semana ${relativeUnit}` : `Día ${relativeUnit}`;
          console.log(`📅 P2 - ${unitLabel}: +$${item.total_amount} (fecha: ${orderDate.toLocaleDateString()})`);
        }
      }
    });

    // Función para obtener label según la agrupación
    const getLabel = (unitNum: number): string => {
      if (groupBy === 'day') {
        // Formato: "21 Dic / 28 Dic" (días traslapados)
        const period1Date = new Date(period1Start);
        period1Date.setDate(period1Date.getDate() + (unitNum - 1));
        const period2Date = new Date(period2Start);
        period2Date.setDate(period2Date.getDate() + (unitNum - 1));

        const p1Label = this.datePipe.transform(period1Date, 'd MMM', 'es-MX') || '';
        const p2Label = this.datePipe.transform(period2Date, 'd MMM', 'es-MX') || '';
        return `${p1Label} / ${p2Label}`;
      } else if (groupBy === 'week') {
        // Para vista semanal, mostrar rango de fechas de la semana
        // Semana 1: días 1-7, Semana 2: días 8-14, etc.
        const firstDayOfWeek = (unitNum - 1) * 7 + 1;
        const lastDayOfWeek = Math.min(unitNum * 7, Math.max(period1Days, period2Days));

        // Fecha inicio de la semana en período 1
        const p1StartWeek = new Date(period1Start);
        p1StartWeek.setDate(p1StartWeek.getDate() + (firstDayOfWeek - 1));
        const p1EndWeek = new Date(period1Start);
        p1EndWeek.setDate(p1EndWeek.getDate() + (lastDayOfWeek - 1));

        // Fecha inicio de la semana en período 2
        const p2StartWeek = new Date(period2Start);
        p2StartWeek.setDate(p2StartWeek.getDate() + (firstDayOfWeek - 1));
        const p2EndWeek = new Date(period2Start);
        p2EndWeek.setDate(p2EndWeek.getDate() + (lastDayOfWeek - 1));

        const p1Label = `${this.datePipe.transform(p1StartWeek, 'd', 'es-MX')}-${this.datePipe.transform(p1EndWeek, 'd MMM', 'es-MX')}`;
        const p2Label = `${this.datePipe.transform(p2StartWeek, 'd', 'es-MX')}-${this.datePipe.transform(p2EndWeek, 'd MMM', 'es-MX')}`;
        return `${p1Label} / ${p2Label}`;
      } else {
        // Para vista mensual
        return `Mes ${unitNum}`;
      }
    };

    // Convertir a array (ordenado por unidad)
    const result: any[] = [];
    dataMap.forEach((value, unitNum) => {
      result.push({
        day: getLabel(unitNum),
        dayNum: unitNum, // Para ordenamiento
        period1: value.period1,
        period2: value.period2,
        period1Name,
        period2Name
      });
    });

    // Ordenar por número de día
    result.sort((a, b) => a.dayNum - b.dayNum);

    // Remover dayNum del resultado final
    return result.map(({ dayNum, ...rest }) => rest);
  }

  updateChart(filteredOrders: Order[] = this.ordersWithShippingCost) {
    this.buildKpis(filteredOrders);

    this.totalSumIsLoading = false;
    this.feesIsLoading = false;
    this.enviosIsLoading = false;
    this.satSumIsLoading = false;
    this.realSumIsLoading = false;

    // Preparar datos según el modo
    let chartData: any[];
    let chartTitle: string;

    if (this.isComparisonMode) {
      // Modo comparación: dos líneas
      chartData = this.prepareTwoMonthsComparison(filteredOrders);
      const period1Name = chartData.length > 0 ? chartData[0].period1Name : 'Período 1';
      const period2Name = chartData.length > 0 ? chartData[0].period2Name : 'Período 2';
      chartTitle = 'Comparación de períodos';

      this.options = {
        data: chartData,
        theme: this.chartTheme.current,
        background: {
          fill: 'transparent'
        },
        series: [
          {
            type: 'line',
            xKey: 'day',
            yKey: 'period1',
            yName: period1Name,
            strokeWidth: 2,
            marker: { enabled: false }
          },
          {
            type: 'line',
            xKey: 'day',
            yKey: 'period2',
            yName: period2Name,
            strokeWidth: 2,
            marker: { enabled: false }
          }
        ],
      axes: [
        {
          type: 'category',
          position: 'bottom',
          label: {
            autoRotate: true,
            fontSize: 11
          }
        },
        {
          type: 'number',
          position: 'left',
          label: {
            formatter: (params: any) => {
              return '$' + params.value.toLocaleString('es-MX', { maximumFractionDigits: 0 });
            }
          }
        }
      ],
      legend: {
        enabled: true,
        position: 'bottom',
        spacing: 40,
        item: {
          marker: {
            shape: 'circle',
            size: 10
          },
          label: {}
        }
      },
      padding: {
        top: 20,
        right: 20,
        bottom: 40,
        left: 20
      },
      tooltip: {
        enabled: true,
        class: 'custom-tooltip'
      }
      };
    } else {
      // Modo rango único: una sola línea
      chartData = this.prepareSingleRange(filteredOrders);
      const rangeName = (this as any).customRangeName || 'Ventas';
      chartTitle = rangeName;

      this.options = {
        data: chartData,
        theme: this.chartTheme.current,
        background: {
          fill: 'transparent'
        },
        series: [
          {
            type: 'bar',
            xKey: 'day',
            yKey: 'sales',
            yName: 'Ventas',
            strokeWidth: 0,
            cornerRadius: 4
          }
        ],
        axes: [
          {
            type: 'category',
            position: 'bottom',
            label: {
              rotation: -45,
              fontSize: 11
            }
          },
          {
            type: 'number',
            position: 'left',
            label: {
              formatter: (params: any) => {
                return '$' + params.value.toLocaleString('es-MX', { maximumFractionDigits: 0 });
              }
            }
          }
        ],
        legend: {
          enabled: false
        },
        padding: {
          top: 20,
          right: 20,
          bottom: 60,
          left: 20
        },
        tooltip: {
          enabled: true,
          class: 'custom-tooltip'
        }
      };
    }
  }

  ngOnDestroy(): void {
    this.offChartTheme?.();
  }
}
