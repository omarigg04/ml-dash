import { Component, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { ColDef, ValueFormatterParams } from 'ag-grid-community';
import { DatePipe } from '@angular/common';
import { Order } from '../interfaces/Order.interface';
import { environment } from '../../environments/environment';

@Component({
  selector: 'app-dashboard',
  templateUrl: './dashboard.component.html',
  styleUrls: ['./dashboard.component.scss']
})
export class DashboardComponent implements OnInit {
  columnDefs: ColDef[] = [];
  rowData: any[] = [];
  isLoading: boolean = true;

  public defaultColDef: ColDef = {
    sortable: true,
    filter: true,
    editable: true,
    resizable: true,
    wrapHeaderText: true,
    autoHeaderHeight: true,
  };

  onGridReady(params: any) {
    params.api.showLoadingOverlay();
  }

  constructor(
    private http: HttpClient,
    private datePipe: DatePipe
  ) {
    this.columnDefs = [
      { headerName: 'Order ID', field: 'id' },
      {
        headerName: 'Created',
        field: 'date_created',
        filter: "agDateColumnFilter",
        valueFormatter: (params: ValueFormatterParams) => {
          const formattedDate = this.datePipe.transform(params.value, 'dd/MM/yyyy, HH:mm');
          return formattedDate !== null ? formattedDate : '';
        },
      },
      { headerName: 'Header Product', field: 'item', width: 500 },
      { headerName: 'Raw Total', field: 'total_amount', valueFormatter: this.formatCurrency, width: 120 },
      { headerName: 'ML Fee', field: 'sale_fee', valueFormatter: this.formatCurrency, width: 120 },
      { headerName: 'SAT Fee', field: 'sat_fee', valueFormatter: this.formatCurrency, width: 120 },
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
          sat_fee: order.total_amount * 0.01 + order.total_amount * 0.08
        }));
        this.isLoading = false;
      },
      (error) => {
        console.error('Error al obtener pedidos:', error);
        this.isLoading = false;
      }
    );
  }

  formatCurrency(params: any): string {
    if (params.value == null) return '';
    return `$${params.value.toFixed(2)}`;
  }
}
