import { LOCALE_ID, DEFAULT_CURRENCY_CODE, NgModule } from '@angular/core';
import { registerLocaleData } from '@angular/common';
import localeEsMx from '@angular/common/locales/es-MX';
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
import { VentasBarsComponent } from './ventas-bars/ventas-bars.component';
import { BrowserAnimationsModule } from '@angular/platform-browser/animations';
import { MatFormFieldModule } from '@angular/material/form-field'; // Importa el módulo del Form Field
import { MatInputModule } from '@angular/material/input';
import { MatDatepickerModule } from '@angular/material/datepicker'; // Importa el módulo del DatePicker
import { MatMomentDateModule } from '@angular/material-moment-adapter'; // Importa MatMomentDateModule para fechas con Moment.js
import { FormsModule, ReactiveFormsModule } from '@angular/forms';
import { MatCardModule } from '@angular/material/card';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { OpportunitiesComponent } from './opportunities/opportunities.component';
import { PublishProductComponent } from './publish-product/publish-product.component';
import { PublicationsListComponent } from './publications-list/publications-list.component';
import { PublicationsTableComponent } from './publications-list/publications-table/publications-table.component';
import { BulkDialogsComponent } from './publications-list/bulk-dialogs/bulk-dialogs.component';
import { MatTableModule } from '@angular/material/table';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatBadgeModule } from '@angular/material/badge';
import { MatSelectModule } from '@angular/material/select';
import { MatTabsModule } from '@angular/material/tabs';
import { MatSnackBarModule } from '@angular/material/snack-bar';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatPaginatorModule } from '@angular/material/paginator';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { SidebarComponent } from './layout/sidebar.component';
import { ImageSourceSelectorComponent } from './components/image-source-selector/image-source-selector.component';
import { TopNavComponent } from './layout/top-nav.component';
import { LayoutComponent } from './layout/layout.component';
import { ImageGalleryComponent } from './image-gallery/image-gallery.component';
import { ToastComponent } from './shared/toast/toast.component';
import { SettingsComponent } from './settings/settings.component';
import { HomeComponent } from './home/home.component';
import { AnalyticsComponent } from './analytics/analytics.component';
import { NotFoundComponent } from './not-found/not-found.component';

registerLocaleData(localeEsMx, 'es-MX');

@NgModule({
  declarations: [
    AppComponent,
    LoginComponent,
    DashboardComponent,
    NavBarComponent,
    VentasBarsComponent,
    PublishProductComponent,
    PublicationsListComponent,
    PublicationsTableComponent,
    BulkDialogsComponent,
    SidebarComponent,
    TopNavComponent,
    LayoutComponent,
    ImageGalleryComponent,
    ToastComponent,
    SettingsComponent,
    ImageSourceSelectorComponent,
    AnalyticsComponent,
    OpportunitiesComponent,
    HomeComponent,
    NotFoundComponent,
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
    MatInputModule,
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
    MatSnackBarModule,
    MatPaginatorModule,
    MatProgressBarModule,
    MatCheckboxModule
  ],
  providers: [
    DatePipe,
    { provide: LOCALE_ID, useValue: 'es-MX' },
    { provide: DEFAULT_CURRENCY_CODE, useValue: 'MXN' },
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
