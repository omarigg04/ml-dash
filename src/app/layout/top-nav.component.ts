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
    // Abrir OAuth de MercadoLibre en una nueva ventana popup
    // En producción: /api/auth, En desarrollo: http://localhost:3000/auth
    const authUrl = environment.production
      ? '/api/auth'  // Producción (Vercel)
      : 'http://localhost:3000/auth';  // Desarrollo local

    // Abrir popup centrado
    const width = 600;
    const height = 700;
    const left = (screen.width - width) / 2;
    const top = (screen.height - height) / 2;

    const popup = window.open(
      authUrl,
      'MercadoLibre OAuth',
      `width=${width},height=${height},left=${left},top=${top},toolbar=no,menubar=no`
    );

    // Opcional: detectar cuando se cierra el popup
    if (popup) {
      const checkClosed = setInterval(() => {
        if (popup.closed) {
          clearInterval(checkClosed);
          console.log('✅ Autorización de MercadoLibre completada');
          // Opcional: recargar datos si es necesario
        }
      }, 500);
    }
  }
}
