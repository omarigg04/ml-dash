import { Component, Input, Output, EventEmitter } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from '../services/auth.service';
import { ThemeService } from '../services/theme.service';
import { environment } from '../../environments/environment';

@Component({
  selector: 'app-top-nav',
  templateUrl: './top-nav.component.html',
  styleUrls: ['./top-nav.component.scss']
})
export class TopNavComponent {
  @Input() navOpen = false;
  @Output() menuToggle = new EventEmitter<void>();

  query = '';

  constructor(
    private authService: AuthService,
    private router: Router,
    private themeService: ThemeService
  ) {}

  get isDark(): boolean {
    return this.themeService.getCurrentTheme() === 'dark';
  }

  toggleTheme(): void {
    this.themeService.toggleTheme();
  }

  /** Búsqueda global: va a Publicaciones con el texto en ?q= (esa pantalla aún no lee el parámetro). */
  onSearch(event: Event): void {
    event.preventDefault();
    const q = this.query.trim();
    this.router.navigate(['/publications'], { queryParams: q ? { q } : {} });
  }

  onMenuToggle() {
    this.menuToggle.emit();
  }

  async logout() {
    await this.authService.logout();
    this.router.navigate(['/login']);
  }

  loginWithMercadoLibre(): void {
    // Abrir OAuth de MercadoLibre en una nueva ventana popup
    const authUrl = `${environment.apiUrl}/auth`;

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
          // Recargar para que los componentes pidan datos con el token nuevo
          window.location.reload();
        }
      }, 500);
    }
  }
}
