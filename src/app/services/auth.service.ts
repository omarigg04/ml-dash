import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { BehaviorSubject, Observable, firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';
import { CachingService } from './caching.service';

export interface AuthStatus {
  authenticated: boolean;
  userId: number | null;
  connected: boolean;
}

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
      this.currentUserSubject.next(status.authenticated ? status : null);
      return status.authenticated;
    } catch (error) {
      this.currentUserSubject.next(null);
      return false;
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
      this.cachingService.invalidateAll();
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
