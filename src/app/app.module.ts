import { NgModule } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';

import { AppRoutingModule } from './app-routing.module';
import { AppComponent } from './app.component';
import { DashboardComponent } from './dashboard/dashboard.component';
import { HttpClientModule } from '@angular/common/http';
import { AgGridModule } from 'ag-grid-angular';
import { NavBarComponent } from './nav-bar/nav-bar.component';
import { DatePipe } from '@angular/common';
import { AgChartsAngularModule } from 'ag-charts-angular';
import { BarChartComponent } from './bar-chart/bar-chart.component';
import { VentasBarsComponent } from './ventas-bars/ventas-bars.component';
import { BrowserAnimationsModule } from '@angular/platform-browser/animations';
import { MatFormFieldModule } from '@angular/material/form-field'; // Importa el módulo del Form Field
import { MatDatepickerModule } from '@angular/material/datepicker'; // Importa el módulo del DatePicker
import { MatMomentDateModule } from '@angular/material-moment-adapter'; // Importa MatMomentDateModule para fechas con Moment.js
import { FormsModule, ReactiveFormsModule } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { PublishProductComponent } from './publish-product/publish-product.component';

@NgModule({
  declarations: [
    AppComponent,
    DashboardComponent,
    NavBarComponent,
    BarChartComponent,
    VentasBarsComponent,
    PublishProductComponent,
  ],
  imports: [
    BrowserModule,
    AppRoutingModule,
    HttpClientModule,
    AgGridModule,
    AgChartsAngularModule,
    BrowserAnimationsModule,
    MatDatepickerModule,
    MatFormFieldModule,
    MatMomentDateModule,
    FormsModule,
    ReactiveFormsModule,
    MatCardModule,
    MatProgressSpinnerModule
    
    
  ],
  providers: [DatePipe],
  bootstrap: [AppComponent]
})
export class AppModule { }
