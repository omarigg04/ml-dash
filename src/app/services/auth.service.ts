import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, Observable, firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';
import { CachingService } from './caching.service';

export interface AuthStatus {
  authenticated: boolean;
  userId: number | null;
  nickname?: string | null;
  connected: boolean;
}

const LAST_ACCOUNT_KEY = 'ml_dash_last_account';

/**
 * Sesión basada en el login de MercadoLibre (OAuth en el backend).
 * La sesión vive en una cookie httpOnly; aquí solo consultamos su estado.
 */
@Injectable({ providedIn: 'root' })
export class AuthService {
  private currentUserSubject = new BehaviorSubject<AuthStatus | null>(null);
  public currentUser$: Observable<AuthStatus | null> = this.currentUserSubject.asObservable();

  constructor(
    private http: HttpClient,
    private cachingService: CachingService
  ) {}

  /**
   * Consulta al backend si hay una sesión activa
   */
  async checkSession(): Promise<boolean> {
    try {
      const status = await firstValueFrom(
        this.http.get<AuthStatus>(`${environment.apiUrl}/auth/status`)
      );
      if (status.authenticated) this.resetDataIfAccountChanged(status.userId);
      this.currentUserSubject.next(status.authenticated ? status : null);
      return status.authenticated;
    } catch (error) {
      this.currentUserSubject.next(null);
      return false;
    }
  }

  /**
   * Navegador compartido entre tiendas: si la cuenta que inició sesión no es la última que usó este
   * navegador (o no hay registro), se borra todo lo guardado (galería, filtros, borradores, cola, caché)
   * ANTES de que ninguna pantalla cargue datos. Una sesión expirada no pasa por aquí (no borra borradores).
   */
  private resetDataIfAccountChanged(userId: number | null): void {
    if (userId === null || userId === undefined) return;
    try {
      const last = localStorage.getItem(LAST_ACCOUNT_KEY);
      if (last !== String(userId)) {
        this.cachingService.clearAllUserData();
        localStorage.setItem(LAST_ACCOUNT_KEY, String(userId));
      }
    } catch {
      // Sin almacenamiento no hay nada que mezclar; se limpia lo que se pueda
      this.cachingService.clearAllUserData();
    }
  }

  /**
   * Inicia el login con MercadoLibre (redirige a la pantalla de autorización de ML)
   */
  login(returnUrl: string = '/'): void {
    window.location.href = `${environment.apiUrl}/auth?returnUrl=${encodeURIComponent(returnUrl)}`;
  }

  /**
   * Logout
   */
  async logout(): Promise<void> {
    try {
      await firstValueFrom(this.http.post(`${environment.apiUrl}/auth/logout`, {}));
    } catch (error) {
      console.error('Logout error:', error);
    } finally {
      // Invalidar TODO el caché de la aplicación
      this.cachingService.clearAllUserData();
      this.currentUserSubject.next(null);
    }
  }

  /**
   * Verifica si el usuario está autenticado (según la última consulta)
   */
  isAuthenticated(): boolean {
    return !!this.currentUserSubject.value;
  }

  /**
   * Obtiene el usuario actual
   */
  getCurrentUser(): AuthStatus | null {
    return this.currentUserSubject.value;
  }
}
