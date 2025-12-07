import { NgModule } from '@angular/core';
import { Routes, RouterModule } from '@angular/router';
import { DashboardComponent } from './dashboard/dashboard.component';
import { BarChartComponent } from './bar-chart/bar-chart.component';
import { PublishProductComponent } from './publish-product/publish-product.component';

// Define tus rutas aquí
const routes: Routes = [
  { path: 'grid', component: DashboardComponent },
  { path: 'chart', component: BarChartComponent },
  { path: 'publish', component: PublishProductComponent },
  { path: '', redirectTo: '/chart', pathMatch: 'full' },
  { path: '**', redirectTo: '/chart' }
];

@NgModule({
  imports: [RouterModule.forRoot(routes)],
  exports: [RouterModule]
})
export class AppRoutingModule { }
