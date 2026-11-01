import { Component, HostListener, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { ColDef, RowClickedEvent, ValueFormatterParams } from 'ag-grid-community';
import { DatePipe } from '@angular/common';
import { Order } from '../interfaces/Order.interface';
import { environment } from '../../environments/environment';

interface ShipmentInfo {
  id: number;
  listCost: number;
  orderCost: number;
  status: string;
}

@Component({
  selector: 'app-dashboard',
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.scss']
})
export class DashboardComponent implements OnInit {
  columnDefs: ColDef[] = [];
  rowData: any[] = [];
  isLoading: boolean = true;

  // Detalle de orden (panel lateral)
  selectedOrder: Order | null = null;
  selectedShipment: ShipmentInfo | null = null;
  isShipmentLoading = false;

  // flex: las columnas se reparten el 100% del ancho y se ajustan al redimensionar
  public defaultColDef: ColDef = {
    sortable: true,
    filter: true,
    resizable: true,
    wrapHeaderText: true,
    autoHeaderHeight: true,
    flex: 1,
    minWidth: 100,
  };

  onGridReady(params: any) {
    params.api.showLoadingOverlay();
  }

  constructor(
    private http: HttpClient,
    private datePipe: DatePipe
  ) {
    this.columnDefs = [
      { headerName: 'Order ID', field: 'id', minWidth: 160 },
      {
        headerName: 'Created',
        field: 'date_created',
        filter: "agDateColumnFilter",
        minWidth: 130,
        valueFormatter: (params: ValueFormatterParams) => {
          const formattedDate = this.datePipe.transform(params.value, 'dd/MM/yyyy');
          return formattedDate !== null ? formattedDate : '';
        },
      },
      { headerName: 'Header Product', field: 'item', flex: 3, minWidth: 250 },
      { headerName: 'Raw Total', field: 'total_amount', valueFormatter: this.formatCurrency },
      { headerName: 'ML Fee', field: 'sale_fee', valueFormatter: this.formatCurrency },
      { headerName: 'SAT Fee', field: 'sat_fee', valueFormatter: this.formatCurrency },
      { headerName: 'QTY', field: 'qty', minWidth: 80 },
      { headerName: 'Status', field: 'status', minWidth: 120 },
    ];
  }

  ngOnInit(): void {
    this.http.get<Order[]>(`${environment.apiUrl}/orders`).subscribe(
      (response: Order[]) => {
        const fulfilledOrders = response.filter(order => order.fulfilled);
        this.rowData = fulfilledOrders.map(order => ({
          id: order.id,
          date_created: new Date(new Date(order.date_created).setHours(0, 0, 0, 0)),
          total_amount: order.total_amount,
          sale_fee: order.order_items[0].sale_fee,
          item: order.order_items[0].item.title,
          sat_fee: this.getSatFee(order),
          qty: order.order_items[0].quantity,
          status: order.payments[0].status,
          order, // orden completa para el panel de detalle
        }));
        this.isLoading = false;
      },
      (error) => {
        console.error('Error al obtener pedidos:', error);
        this.isLoading = false;
      }
    );
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
        if (this.selectedOrder?.id === order.id) this.selectedShipment = shipment;
        this.isShipmentLoading = false;
      },
      error: err => {
        console.error('Error al obtener envío:', err);
        this.isShipmentLoading = false;
      }
    });
  }

  @HostListener('document:keydown.escape')
  closeOrderDetail(): void {
    this.selectedOrder = null;
    this.selectedShipment = null;
  }

  // Comisiones de ML de todos los artículos (sale_fee es por unidad)
  getTotalSaleFee(order: Order): number {
    return order.order_items.reduce((sum, item) => sum + item.sale_fee * item.quantity, 0);
  }

  // Retenciones SAT: 1% ISR + 8% IVA sobre el total
  getSatFee(order: Order): number {
    return order.total_amount * 0.01 + order.total_amount * 0.08;
  }

  getNetAmount(order: Order): number {
    const shippingCost = this.selectedShipment?.listCost ?? 0;
    return order.total_amount - this.getTotalSaleFee(order) - this.getSatFee(order) - shippingCost;
  }

  get buyerNickname(): string {
    // La API regresa buyer como objeto aunque la interfaz lo declara como arreglo
    const buyer: any = this.selectedOrder?.buyer;
    return buyer?.nickname ?? (Array.isArray(buyer) ? buyer[0]?.nickname : '') ?? '';
  }

  get mlOrderUrl(): string {
    return `https://www.mercadolibre.com.mx/ventas/${this.selectedOrder?.id}/detalle`;
  }

  formatCurrency(params: any): string {
    if (params.value == null) return '';
    return `$${params.value.toFixed(2)}`;
  }
}
