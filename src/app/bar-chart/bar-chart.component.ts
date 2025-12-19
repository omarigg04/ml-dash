import { Component, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { FormGroup, FormControl } from '@angular/forms';
import { Order } from '../interfaces/Order.interface';
import { DatePipe } from '@angular/common';
import { forkJoin, of } from 'rxjs';
import { catchError, map, mergeMap } from 'rxjs/operators';
import { environment } from '../../environments/environment';

@Component({
  selector: 'app-bar-chart',
  templateUrl: './bar-chart.component.html',
  styleUrls: ['./bar-chart.component.scss'],
})
export class BarChartComponent implements OnInit {
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
  dateRangeForm: FormGroup;
  maxDate: Date = new Date(); // Fecha máxima: hoy
  selectedStartDate: Date | null = null;
  selectedEndDate: Date | null = null;
  selectedPeriod: string = '2months'; // Valor por defecto
  customStartDate: Date | null = null;
  customEndDate: Date | null = null;

  constructor(private http: HttpClient, private datePipe: DatePipe) {
    this.dateRangeForm = new FormGroup({
      start: new FormControl(),
      end: new FormControl(),
    });
  }

  ngOnInit(): void {
    this.http.get<Order[]>(`${environment.apiUrl}/orders`).pipe(
      map(orders => orders.filter(order => order.fulfilled)),
      mergeMap(fulfilledOrders => {
        this.chartData = fulfilledOrders.map(order => {
          const date = new Date(order.date_created);
          const saleFee = order.order_items.reduce((sum, item) => sum + item.sale_fee, 0);

          return { date, total_amount: order.total_amount, saleFee };
        });

        const shipmentCostRequests = fulfilledOrders.map(order =>
          this.http.get<{ listCost: number }>(`${environment.apiUrl}/shipments/${order.shipping.id}`).pipe(
            catchError(() => of({ listCost: 0 }))
          )
        );

        return forkJoin(shipmentCostRequests).pipe(
          map(listCosts => {
            return fulfilledOrders.map((order, index) => ({
              ...order,
              listCost: listCosts[index].listCost
            }));
          })
        );
      })
    ).subscribe(ordersWithShippingCost => {
      this.ordersWithShippingCost = ordersWithShippingCost;
      this.envios = ordersWithShippingCost.reduce((acc, order) => acc + order.listCost, 0);
      this.filteredChartData = this.chartData;
      this.updateChart();
      this.isLoading = false;
      this.enviosIsLoading = false;
    }, error => {
      console.error('Error al obtener pedidos:', error);
      this.isLoading = false;
    });
  }

  onPeriodChange(period: string) {
    const now = new Date();
    let startDate: Date, endDate: Date;

    switch (period) {
      case '2weeks':
        // Últimas 2 semanas (14 días cada una) = 28 días total
        endDate = new Date(now);
        startDate = new Date(now);
        startDate.setDate(startDate.getDate() - 28);
        break;

      case '2months':
        // Últimos 2 meses: mes actual + mes anterior
        endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0); // Último día del mes actual
        startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1); // Primer día del mes anterior
        break;

      case '2bimesters':
        // Últimos 2 bimestres (4 meses total)
        endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0); // Último día del mes actual
        startDate = new Date(now.getFullYear(), now.getMonth() - 3, 1); // Primer día de hace 4 meses
        break;

      case '2years':
        // Últimos 2 años
        endDate = new Date(now.getFullYear(), 11, 31); // 31 de diciembre del año actual
        startDate = new Date(now.getFullYear() - 1, 0, 1); // 1 de enero del año anterior
        break;

      case 'custom':
        // No hacer nada, esperar a que el usuario seleccione fechas
        return;

      default:
        return;
    }

    this.selectedStartDate = startDate;
    this.selectedEndDate = endDate;
    this.selectedPeriod = period;

    const inclusiveEnd = new Date(endDate);
    inclusiveEnd.setDate(inclusiveEnd.getDate() + 1);

    const dateFilteredOrders = this.ordersWithShippingCost.filter((order) => {
      const orderDate = new Date(order.date_created);
      return orderDate >= startDate && orderDate < inclusiveEnd;
    });

    this.updateChart(dateFilteredOrders);
  }

  applyCustomRange() {
    if (this.customStartDate && this.customEndDate) {
      // Validar que el rango no sea mayor a 2 años
      const diffTime = Math.abs(this.customEndDate.getTime() - this.customStartDate.getTime());
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

      if (diffDays > 730) {
        alert('El rango seleccionado no puede ser mayor a 2 años');
        return;
      }

      this.selectedStartDate = new Date(this.customStartDate);
      this.selectedEndDate = new Date(this.customEndDate);

      const inclusiveEnd = new Date(this.customEndDate);
      inclusiveEnd.setDate(inclusiveEnd.getDate() + 1);

      const dateFilteredOrders = this.ordersWithShippingCost.filter((order) => {
        const orderDate = new Date(order.date_created);
        return orderDate >= this.customStartDate! && orderDate < inclusiveEnd;
      });

      this.updateChart(dateFilteredOrders);
    }
  }

  resetFilter() {
    this.selectedPeriod = '2months';
    this.customStartDate = null;
    this.customEndDate = null;
    this.selectedStartDate = null;
    this.selectedEndDate = null;
    this.updateChart();
  }

  private aggregateDataByDate(data: any[]): any[] {
    const aggregatedData = new Map<string, { total_amount: number, sale_fee: number }>();

    data.forEach(({ date, total_amount, sale_fee }) => {
      const dateKey = this.datePipe.transform(date, 'MM-dd-yyyy');
      if (!dateKey) return;

      if (aggregatedData.has(dateKey)) {
        const existing = aggregatedData.get(dateKey)!;
        existing.total_amount += total_amount;
        existing.sale_fee += sale_fee;
      } else {
        aggregatedData.set(dateKey, { total_amount: total_amount, sale_fee: sale_fee });
      }
    });

    return Array.from(aggregatedData, ([date, { total_amount, sale_fee }]) => ({
      date: new Date(date),
      total_amount,
      sale_fee
    }));
  }

  // Prepara datos para comparación de períodos (dinámico con agrupación)
  private prepareTwoMonthsComparison(): any[] {
    let period1Start: Date, period1End: Date, period2Start: Date, period2End: Date;
    let period1Name: string, period2Name: string;
    let groupBy: 'day' | 'week' | 'month' = 'day';

    // Determinar agrupación según el período
    if (this.selectedPeriod === '2bimesters') {
      groupBy = 'week';
    } else if (this.selectedPeriod === '2years') {
      groupBy = 'month';
    }

    // Si hay filtro aplicado, usar esas fechas
    if (this.selectedStartDate && this.selectedEndDate) {
      // Calcular la duración del período seleccionado
      const diffTime = this.selectedEndDate.getTime() - this.selectedStartDate.getTime();
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

      // Dividir el período en dos mitades
      const halfDays = Math.floor(diffDays / 2);

      period1Start = new Date(this.selectedStartDate);
      period1End = new Date(period1Start);
      period1End.setDate(period1End.getDate() + halfDays - 1);

      period2Start = new Date(period1End);
      period2Start.setDate(period2Start.getDate() + 1);
      period2End = new Date(this.selectedEndDate);

      // Nombres de períodos
      const formatDate = (date: Date) => date.toLocaleDateString('es-MX', { month: 'short', day: 'numeric' });
      period1Name = `${formatDate(period1Start)} - ${formatDate(period1End)}`;
      period2Name = `${formatDate(period2Start)} - ${formatDate(period2End)}`;
    } else {
      // Por defecto: mes actual vs mes anterior
      const now = new Date();
      const currentMonth = now.getMonth();
      const currentYear = now.getFullYear();

      period2Start = new Date(currentYear, currentMonth, 1);
      period2End = new Date(currentYear, currentMonth + 1, 0);
      period1Start = new Date(currentYear, currentMonth - 1, 1);
      period1End = new Date(currentYear, currentMonth, 0);

      const currentMonthName = now.toLocaleString('es-MX', { month: 'long' });
      const previousMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const previousMonthName = previousMonth.toLocaleString('es-MX', { month: 'long' });

      period1Name = previousMonthName.charAt(0).toUpperCase() + previousMonthName.slice(1);
      period2Name = currentMonthName.charAt(0).toUpperCase() + currentMonthName.slice(1);
    }

    // Función para obtener la clave de agrupación
    const getGroupKey = (date: Date): string => {
      if (groupBy === 'day') {
        return this.datePipe.transform(date, 'dd MMM') || '';
      } else if (groupBy === 'week') {
        // Obtener número de semana del año
        const startOfYear = new Date(date.getFullYear(), 0, 1);
        const daysSinceStart = Math.floor((date.getTime() - startOfYear.getTime()) / (1000 * 60 * 60 * 24));
        const weekNumber = Math.ceil((daysSinceStart + startOfYear.getDay() + 1) / 7);
        return `Sem ${weekNumber}`;
      } else { // month
        return this.datePipe.transform(date, 'MMM yyyy') || '';
      }
    };

    // Agrupar datos
    const dataMap = new Map<string, { period1: number, period2: number }>();

    // Procesar datos del período 1
    this.chartData.forEach(item => {
      const date = new Date(item.date);
      if (date >= period1Start && date <= period1End) {
        const key = getGroupKey(date);
        if (!dataMap.has(key)) {
          dataMap.set(key, { period1: 0, period2: 0 });
        }
        dataMap.get(key)!.period1 += item.total_amount;
      }
    });

    // Procesar datos del período 2
    this.chartData.forEach(item => {
      const date = new Date(item.date);
      if (date >= period2Start && date <= period2End) {
        const key = getGroupKey(date);
        if (!dataMap.has(key)) {
          dataMap.set(key, { period1: 0, period2: 0 });
        }
        dataMap.get(key)!.period2 += item.total_amount;
      }
    });

    // Convertir a array para el gráfico
    const result: any[] = [];
    dataMap.forEach((value, key) => {
      result.push({
        day: key,
        period1: value.period1,
        period2: value.period2,
        period1Name,
        period2Name
      });
    });

    return result;
  }

  updateChart(filteredOrders: Order[] = this.ordersWithShippingCost) {
    this.totalSum = filteredOrders.reduce((acc, curr) => acc + curr.total_amount, 0);
    this.fees = filteredOrders.reduce((acc, curr) => acc + curr.order_items.reduce((sum, item) => sum + item.sale_fee, 0), 0);
    this.envios = filteredOrders.reduce((acc, curr) => acc + curr.listCost, 0);
    this.satSum = this.totalSum * 0.08;
    this.realSum = this.totalSum - (this.satSum + this.envios + this.fees);

    this.totalSumIsLoading = false;
    this.feesIsLoading = false;
    this.enviosIsLoading = false;
    this.satSumIsLoading = false;
    this.realSumIsLoading = false;

    // Preparar datos de comparación de períodos
    const comparisonData = this.prepareTwoMonthsComparison();

    // Obtener nombres de los períodos desde los datos
    const period1Name = comparisonData.length > 0 ? comparisonData[0].period1Name : 'Período 1';
    const period2Name = comparisonData.length > 0 ? comparisonData[0].period2Name : 'Período 2';

    // Configuración del gráfico con estilo CMS
    this.options = {
      data: comparisonData,
      series: [
        {
          type: 'line',
          xKey: 'day',
          yKey: 'period2',
          yName: period2Name,
          stroke: '#3B82F6',  // Blue
          strokeWidth: 3,
          marker: {
            enabled: true,
            size: 6,
            fill: '#3B82F6',
            stroke: '#ffffff',
            strokeWidth: 2
          }
        },
        {
          type: 'line',
          xKey: 'day',
          yKey: 'period1',
          yName: period1Name,
          stroke: '#2EC291',  // Green
          strokeWidth: 3,
          marker: {
            enabled: true,
            size: 6,
            fill: '#2EC291',
            stroke: '#ffffff',
            strokeWidth: 2
          }
        }
      ],
      axes: [
        {
          type: 'category',
          position: 'bottom',
          title: {
            text: 'Día del Mes',
            enabled: true
          },
          label: {
            rotation: 0,
            fontSize: 12
          }
        },
        {
          type: 'number',
          position: 'left',
          title: {
            text: 'Ventas (MXN)',
            enabled: true
          },
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
          label: {
            fontSize: 14,
            fontWeight: '500'
          }
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
  }
}
