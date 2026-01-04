import { Component, OnInit } from '@angular/core';
import { ThemeService, Theme } from '../services/theme.service';
import { environment } from '../../environments/environment';

@Component({
  selector: 'app-settings',
  templateUrl: './settings.component.html',
  styleUrls: ['./settings.component.scss']
})
export class SettingsComponent implements OnInit {
  currentTheme: Theme;
  isDarkMode: boolean;

  constructor(private themeService: ThemeService) {
    // Initialize with current theme to avoid flash/change on load
    const current = this.themeService.getCurrentTheme();
    this.currentTheme = current;
    this.isDarkMode = current === 'dark';
  }

  ngOnInit(): void {
    // Subscribe to theme changes
    this.themeService.theme$.subscribe(theme => {
      this.currentTheme = theme;
      this.isDarkMode = theme === 'dark';
    });
  }

  toggleTheme(): void {
    this.themeService.toggleTheme();
  }

  setTheme(theme: Theme): void {
    this.themeService.setTheme(theme);
  }

  loginWithMercadoLibre(): void {
    // Abrir OAuth de MercadoLibre en una nueva ventana popup
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
