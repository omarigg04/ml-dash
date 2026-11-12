import { Component, HostListener, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { ColDef, ICellRendererParams, RowClickedEvent, ValueFormatterParams } from 'ag-grid-community';
import { DatePipe } from '@angular/common';
import { Order } from '../interfaces/Order.interface';
import { environment } from '../../environments/environment';
import { GRID_LOCALE_ES } from '../shared/grid-locale';
import { orderNet, orderSaleFee, satRetention } from '../shared/order-math';

interface ShipmentInfo {
  id: number;
  listCost: number;
  orderCost: number;
  status: string;
  substatus?: string | null;
  phase?: string | null;
}

type Tone = 'success' | 'warning' | 'info' | 'error' | 'off';

interface StatusInfo {
  label: string;
  tone: Tone;
}

// Estados de pago/orden de ML traducidos. Lo desconocido se muestra tal cual con tono neutro.
const ORDER_STATUS: Record<string, StatusInfo> = {
  approved: { label: 'Pagada', tone: 'success' },
  paid: { label: 'Pagada', tone: 'success' },
  authorized: { label: 'Autorizada', tone: 'info' },
  pending: { label: 'Pago pendiente', tone: 'warning' },
  in_process: { label: 'En proceso', tone: 'warning' },
  in_mediation: { label: 'En mediación', tone: 'warning' },
  rejected: { label: 'Rechazada', tone: 'error' },
  cancelled: { label: 'Cancelada', tone: 'error' },
  refunded: { label: 'Reembolsada', tone: 'off' },
  partially_refunded: { label: 'Reembolso parcial', tone: 'off' },
  charged_back: { label: 'Contracargo', tone: 'error' },
  confirmed: { label: 'Confirmada', tone: 'info' },
  payment_required: { label: 'Pago requerido', tone: 'warning' },
};

const SHIPMENT_STATUS: Record<string, StatusInfo> = {
  pending: { label: 'Pendiente', tone: 'warning' },
  handling: { label: 'En preparación', tone: 'warning' },
  ready_to_ship: { label: 'Listo para enviar', tone: 'warning' },
  shipped: { label: 'En camino', tone: 'info' },
  delivered: { label: 'Entregado', tone: 'success' },
  not_delivered: { label: 'No entregado', tone: 'error' },
  cancelled: { label: 'Cancelado', tone: 'error' },
  returned: { label: 'Devuelto', tone: 'off' },
};

const PHASES: Record<string, StatusInfo> = {
  to_ship: { label: 'Por enviar', tone: 'warning' },
  in_transit: { label: 'En camino', tone: 'info' },
  delivered: { label: 'Entregada', tone: 'success' },
  cancelled: { label: 'Cancelada', tone: 'error' },
};

@Component({
  selector: 'app-dashboard',
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.scss']
})
export class DashboardComponent implements OnInit {
  columnDefs: ColDef[] = [];
  rowData: any[] = [];
  allRows: any[] = [];
  isLoading = true;
  loadError = false;
  readonly localeText = { ...GRID_LOCALE_ES, noRowsToShow: 'Sin órdenes que coincidan con tu búsqueda' };
  readonly skeletonRows = [1, 2, 3, 4, 5, 6];

  // Tarjetas en móvil (<= 640px): se muestran por tandas
  readonly cardsStep = 30;
  cardsLimit = this.cardsStep;

  // Buscador y chips de estado
  searchTerm = '';
  statusFilter = 'all';

  // Detalle de orden (panel lateral)
  selectedOrder: Order | null = null;
  selectedShipment: ShipmentInfo | null = null;
  isShipmentLoading = false;

  // flex: las columnas se reparten el 100% del ancho y se ajustan al redimensionar
  public defaultColDef: ColDef = {
    sortable: true,
    filter: false,
    resizable: true,
    wrapHeaderText: true,
    autoHeaderHeight: true,
    flex: 1,
    minWidth: 100,
  };

  constructor(
    private http: HttpClient,
    private datePipe: DatePipe
  ) {
    const num: ColDef = { cellClass: 'ds-num', headerClass: 'ag-right-aligned-header', type: 'rightAligned' };
    this.columnDefs = [
      { headerName: 'Venta', field: 'id', flex: 0, width: 160, cellClass: 'ds-mono' },
      {
        headerName: 'Fecha',
        field: 'date_created',
        flex: 0,
        width: 150,
        valueFormatter: (params: ValueFormatterParams) =>
          this.datePipe.transform(params.value, 'dd/MM/yyyy HH:mm') ?? '',
      },
      { headerName: 'Producto', field: 'item', flex: 3, minWidth: 180 },
      { headerName: 'Total', field: 'total_amount', minWidth: 100, valueFormatter: this.formatCurrency, ...num },
      { headerName: 'Comisión ML', field: 'sale_fee', minWidth: 110, valueFormatter: this.formatCurrency, ...num },
      { headerName: 'Retención SAT', field: 'sat_fee', minWidth: 120, valueFormatter: this.formatCurrency, ...num },
      { headerName: 'Cant.', field: 'qty', minWidth: 70, maxWidth: 90, ...num },
      {
        headerName: 'Envío',
        field: 'phase',
        minWidth: 120,
        cellRenderer: (p: ICellRendererParams) => {
          const info = PHASES[p.value] ?? { label: '—', tone: 'off' };
          return `<span class="ds-badge tone-${info.tone}">${info.label}</span>`;
        },
      },
      {
        headerName: 'Estado',
        field: 'status',
        minWidth: 150,
        cellRenderer: (p: ICellRendererParams) => {
          const info = this.statusInfo(p.value);
          return `<span class="ds-badge tone-${info.tone}">${info.label}</span>`;
        },
      },
    ];
  }

  ngOnInit(): void {
    this.loadOrders();
  }

  private loadOrders(): void {
    this.http.get<Order[]>(`${environment.apiUrl}/orders`).subscribe({
      next: (response: Order[]) => {
        // Fase: cancelled -> 'cancelled'; tag 'delivered' -> 'delivered'; si no, la fase del envío que
        // /api/orders consulta para las órdenes abiertas ('to_ship' o 'in_transit', como en Mercado Libre).
        // Sin estado del envío se queda en 'to_ship'. "Todas" excluye las canceladas (están en su chip).
        // `id` es el número de venta de Mercado Libre (pack_id); el id interno de la orden va en `orderId`.
        this.allRows = response.map(order => {
          const items = order.order_items;
          const extra = items.length > 1 ? ` (+${items.length - 1} más)` : '';
          return {
            id: order.pack_id ?? order.id,
            orderId: order.id,
            date_created: new Date(order.date_created),
            total_amount: order.total_amount,
            // Misma cifra que el panel de detalle (comisión × cantidad de todos los artículos)
            sale_fee: this.getTotalSaleFee(order),
            item: (items[0]?.item.title ?? '') + extra,
            sat_fee: this.getSatFee(order),
            qty: items.reduce((sum, i) => sum + i.quantity, 0),
            status: order.status === 'cancelled' ? 'cancelled' : (order.payments[0]?.status ?? order.status),
            phase: this.phaseOf(order),
            buyer: this.buyerOf(order),
            order, // orden completa para el panel de detalle
          };
        });
        this.applyFilters();
        this.isLoading = false;
      },
      error: (error) => {
        console.error('Error al obtener pedidos:', error);
        this.loadError = true;
        this.isLoading = false;
      }
    });
  }

  private phaseOf(order: Order): string {
    if (order.status === 'cancelled') return 'cancelled';
    if (order.tags?.includes('delivered')) return 'delivered';
    const phase = order.shipping?.phase;
    return phase === 'in_transit' || phase === 'delivered' ? phase : 'to_ship';
  }

  reload(): void {
    this.isLoading = true;
    this.loadError = false;
    this.allRows = [];
    this.rowData = [];
    this.loadOrders();
  }

  // ---- Buscador y chips ----
  onSearch(term: string): void {
    this.searchTerm = term;
    this.applyFilters();
  }

  setStatusFilter(status: string): void {
    this.statusFilter = status;
    this.applyFilters();
  }

  private applyFilters(): void {
    const term = this.searchTerm.trim().toLowerCase();
    this.rowData = this.allRows.filter(row =>
      (this.statusFilter === 'all' ? row.phase !== 'cancelled' : row.phase === this.statusFilter) &&
      (!term ||
        String(row.id).includes(term) ||
        String(row.orderId).includes(term) ||
        row.item.toLowerCase().includes(term) ||
        (row.buyer ?? '').toLowerCase().includes(term))
    );
    this.cardsLimit = this.cardsStep;
  }

  /** Chips de la bandeja con conteo (solo los que tienen órdenes, salvo "Todas"). */
  get statusChips(): { key: string; label: string; count: number }[] {
    const count = (phase: string) => this.allRows.filter(r => r.phase === phase).length;
    const chips = [
      { key: 'all', label: 'Todas', count: this.allRows.length - count('cancelled') },
      { key: 'to_ship', label: 'Por enviar', count: count('to_ship') },
      { key: 'in_transit', label: 'En camino', count: count('in_transit') },
      { key: 'delivered', label: 'Entregadas', count: count('delivered') },
      { key: 'cancelled', label: 'Canceladas', count: count('cancelled') },
    ];
    return chips.filter(c => c.key === 'all' || c.count > 0);
  }

  phaseLabel(phase: string): StatusInfo {
    return PHASES[phase] ?? { label: '—', tone: 'off' };
  }

  statusInfo(status: string | undefined): StatusInfo {
    return ORDER_STATUS[status ?? ''] ?? { label: status || '—', tone: 'off' };
  }

  shipmentInfo(status: string | undefined, phase?: string | null): StatusInfo {
    // Listo para enviar pero ya en la agencia o con la paquetería: Mercado Libre lo muestra "En camino"
    if (status === 'ready_to_ship' && phase === 'in_transit') return SHIPMENT_STATUS['shipped'];
    return SHIPMENT_STATUS[status ?? ''] ?? { label: status || '—', tone: 'off' };
  }

  get cardRows(): any[] {
    return this.rowData.slice(0, this.cardsLimit);
  }

  showMoreCards(): void {
    this.cardsLimit += this.cardsStep;
  }

  onRowClicked(event: RowClickedEvent): void {
    this.openOrderDetail(event.data.order);
  }

  openOrderDetail(order: Order): void {
    this.selectedOrder = order;
    this.selectedShipment = null;

    if (!order.shipping?.id) return;

    this.isShipmentLoading = true;
    this.http.get<ShipmentInfo>(`${environment.apiUrl}/shipments/${order.shipping.id}`).subscribe({
      next: shipment => {
        // Ignorar respuestas de una orden que ya no está seleccionada
        if (this.selectedOrder?.id === order.id) {
          this.selectedShipment = shipment;
          this.isShipmentLoading = false;
        }
      },
      error: err => {
        console.error('Error al obtener envío:', err);
        if (this.selectedOrder?.id === order.id) this.isShipmentLoading = false;
      }
    });
  }

  @HostListener('document:keydown.escape')
  closeOrderDetail(): void {
    this.selectedOrder = null;
    this.selectedShipment = null;
    this.isShipmentLoading = false;
  }

  // Comisiones de ML de todos los artículos (sale_fee es por unidad)
  getTotalSaleFee(order: Order): number {
    return orderSaleFee(order);
  }

  // Retenciones SAT: 2.5% ISR + 8% IVA sobre el precio sin IVA
  getSatFee(order: Order): number {
    return satRetention(order.total_amount);
  }

  // null mientras el envío carga o si no se pudo obtener; sin envío asociado no hay costo
  getNetAmount(order: Order): number | null {
    if (this.isShipmentLoading) return null;
    const shippingCost = order.shipping?.id ? this.selectedShipment?.listCost ?? null : 0;
    return orderNet(order, shippingCost);
  }

  private buyerOf(order: Order): string {
    // La API regresa buyer como objeto aunque la interfaz lo declara como arreglo
    const buyer: any = order.buyer;
    return buyer?.nickname ?? (Array.isArray(buyer) ? buyer[0]?.nickname : '') ?? '';
  }

  get buyerNickname(): string {
    return this.selectedOrder ? this.buyerOf(this.selectedOrder) : '';
  }

  get mlOrderUrl(): string {
    return `https://www.mercadolibre.com.mx/ventas/${this.selectedOrder?.id}/detalle`;
  }

  formatCurrency(params: any): string {
    if (params.value == null) return '';
    return Number(params.value).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
  }
}
