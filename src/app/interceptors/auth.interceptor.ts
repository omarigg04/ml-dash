import { Injectable } from '@angular/core';
import { HttpInterceptor, HttpRequest, HttpHandler, HttpEvent } from '@angular/common/http';
import { Observable } from 'rxjs';
import { AuthService } from '../services/auth.service';

@Injectable()
export class AuthInterceptor implements HttpInterceptor {
  constructor(private authService: AuthService) {}

  intercept(req: HttpRequest<any>, next: HttpHandler): Observable<HttpEvent<any>> {
    // TEMPORALMENTE SIMPLIFICADO:
    // Como el authMiddleware del backend está deshabilitado,
    // no necesitamos enviar credenciales por ahora

    // Simplemente pasar el request sin modificaciones
    return next.handle(req);
  }
}
