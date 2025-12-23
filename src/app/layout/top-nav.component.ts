import { Component, Output, EventEmitter } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '../services/auth.service';
import { environment } from '../../environments/environment';

@Component({
  selector: 'app-top-nav',
  templateUrl: './top-nav.component.html',
  styleUrls: ['./top-nav.component.scss']
})
export class TopNavComponent {
  @Output() menuToggle = new EventEmitter<void>();

  constructor(
    private authService: AuthService,
    private router: Router
  ) {}

  onMenuToggle() {
    this.menuToggle.emit();
  }

  async logout() {
    await this.authService.logout();
    this.router.navigate(['/login']);
  }

  loginWithMercadoLibre(): void {
    // Construct the base URL by removing '/api' and then append the correct endpoint.
    const baseUrl = environment.apiUrl.replace('/api', '');
    window.location.href = `${baseUrl}/auth`;
  }
}
