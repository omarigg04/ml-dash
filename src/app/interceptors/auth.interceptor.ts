import { Injectable } from '@angular/core';
import { HttpInterceptor, HttpRequest, HttpHandler, HttpEvent, HttpErrorResponse } from '@angular/common/http';
import { Router } from '@angular/router';
import { CachingService } from '../services/caching.service';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';

@Injectable()
export class AuthInterceptor implements HttpInterceptor {
  constructor(private router: Router, private cachingService: CachingService) {}

  intercept(req: HttpRequest<any>, next: HttpHandler): Observable<HttpEvent<any>> {
    // La sesión viaja en una cookie httpOnly (mismo dominio en producción),
    // así que solo hay que reaccionar cuando expira. Otros 401 (p.ej. el token
    // de ML no disponible) los maneja cada componente, sin sacar al usuario.
    return next.handle(req).pipe(
      catchError((error: HttpErrorResponse) => {
        const sessionExpired = error.status === 401 && error.error?.code === 'SESSION_REQUIRED';
        if (sessionExpired) {
          // Solo datos de ventas: una sesión vencida no debe borrar borradores ni filtros
          this.cachingService.invalidateAll();
        }
        if (sessionExpired && !this.router.url.startsWith('/login')) {
          this.router.navigate(['/login'], {
            queryParams: { returnUrl: this.router.url }
          });
        }
        return throwError(() => error);
      })
    );
  }
}
