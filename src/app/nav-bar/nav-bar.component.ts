import { Component } from '@angular/core';
import { environment } from '../../environments/environment';

@Component({
  selector: 'app-nav-bar',
  templateUrl: './nav-bar.component.html',
  styleUrls: ['./nav-bar.component.scss']
})
export class NavBarComponent {

  loginWithMercadoLibre(): void {
    // Redirect to backend OAuth endpoint
    window.location.href = `${environment.apiUrl}/auth`;
  }

}
