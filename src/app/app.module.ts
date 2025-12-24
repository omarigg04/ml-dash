import { NgModule } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';

import { AppRoutingModule } from './app-routing.module';
import { AppComponent } from './app.component';
import { DashboardComponent } from './dashboard/dashboard.component';
import { HttpClientModule, HTTP_INTERCEPTORS } from '@angular/common/http';
import { AgGridModule } from 'ag-grid-angular';
import { LoginComponent } from './auth/login/login.component';
import { AuthInterceptor } from './interceptors/auth.interceptor';
import { CachingInterceptor } from './interceptors/caching.interceptor';
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
import { PublicationsListComponent } from './publications-list/publications-list.component';
import { MatTableModule } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatBadgeModule } from '@angular/material/badge';
import { MatSelectModule } from '@angular/material/select';
import { MatTabsModule } from '@angular/material/tabs';
import { MatSnackBarModule } from '@angular/material/snack-bar';
import { SidebarComponent } from './layout/sidebar.component';
import { TopNavComponent } from './layout/top-nav.component';
import { LayoutComponent } from './layout/layout.component';
import { ImageGalleryComponent } from './image-gallery/image-gallery.component';
import { ToastComponent } from './shared/toast/toast.component';
import { SettingsComponent } from './settings/settings.component';

@NgModule({
  declarations: [
    AppComponent,
    LoginComponent,
    DashboardComponent,
    NavBarComponent,
    BarChartComponent,
    VentasBarsComponent,
    PublishProductComponent,
    PublicationsListComponent,
    SidebarComponent,
    TopNavComponent,
    LayoutComponent,
    ImageGalleryComponent,
    ToastComponent,
    SettingsComponent,
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
    MatProgressSpinnerModule,
    MatTableModule,
    MatButtonModule,
    MatIconModule,
    MatTooltipModule,
    MatBadgeModule,
    MatSelectModule,
    MatTabsModule,
    MatSnackBarModule
  ],
  providers: [
    DatePipe,
    // IMPORTANTE: CachingInterceptor DEBE ir ANTES que AuthInterceptor
    // para que las respuestas cacheadas no pasen por autenticación
    {
      provide: HTTP_INTERCEPTORS,
      useClass: CachingInterceptor,
      multi: true
    },
    {
      provide: HTTP_INTERCEPTORS,
      useClass: AuthInterceptor,
      multi: true
    }
  ],
  bootstrap: [AppComponent]
})
export class AppModule { }
