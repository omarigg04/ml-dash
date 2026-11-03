import { NgModule } from '@angular/core';
import { RouterModule, Routes } from '@angular/router';
import { AuthGuard } from './guards/auth.guard';
import { LoginComponent } from './auth/login/login.component';
import { LayoutComponent } from './layout/layout.component';
import { DashboardComponent } from './dashboard/dashboard.component';
import { BarChartComponent } from './bar-chart/bar-chart.component';
import { HomeComponent } from './home/home.component';
import { AnalyticsComponent } from './analytics/analytics.component';
import { PublishProductComponent } from './publish-product/publish-product.component';
import { PublicationsListComponent } from './publications-list/publications-list.component';
import { ImageGalleryComponent } from './image-gallery/image-gallery.component';
import { SettingsComponent } from './settings/settings.component';
import { NotFoundComponent } from './not-found/not-found.component';

const routes: Routes = [
  // Public route
  {
    path: 'login',
    component: LoginComponent
  },
  // Protected routes
  {
    path: '',
    component: LayoutComponent,
    canActivate: [AuthGuard],
    children: [
      { path: 'inicio', component: HomeComponent },
      { path: 'analytics', component: AnalyticsComponent },
      { path: 'orders', component: DashboardComponent },
      { path: 'publish', component: PublishProductComponent },
      { path: 'publications', component: PublicationsListComponent },
      { path: 'gallery', component: ImageGalleryComponent },
      { path: 'settings', component: SettingsComponent },
      { path: '', redirectTo: 'inicio', pathMatch: 'full' }
    ]
  },
  // 404 - Page not found
  { path: '**', component: NotFoundComponent }
];

@NgModule({
  imports: [RouterModule.forRoot(routes)],
  exports: [RouterModule]
})
export class AppRoutingModule { }
