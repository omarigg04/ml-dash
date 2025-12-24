import { Injectable } from '@angular/core';
import {
  HttpEvent,
  HttpHandler,
  HttpInterceptor,
  HttpRequest,
  HttpResponse
} from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { tap } from 'rxjs/operators';
import { CachingService } from '../services/caching.service';

/**
 * HTTP Interceptor que implementa caching transparente para peticiones GET
 *
 * Flujo:
 * 1. Intercepta todas las peticiones HTTP
 * 2. Si es GET, intenta obtener respuesta del caché
 * 3. Si existe en caché y es válida, retorna inmediatamente
 * 4. Si no existe, procede con la petición de red
 * 5. Guarda respuestas exitosas en caché para uso futuro
 */
@Injectable()
export class CachingInterceptor implements HttpInterceptor {
  constructor(private cachingService: CachingService) {}

  intercept(req: HttpRequest<any>, next: HttpHandler): Observable<HttpEvent<any>> {
    // Solo cachear peticiones GET
    if (req.method !== 'GET') {
      return next.handle(req);
    }

    // Generar clave de caché basada en la URL completa
    const cacheKey = req.urlWithParams;

    // Intentar obtener del caché
    const cachedResponse = this.cachingService.get(cacheKey);

    if (cachedResponse) {
      // Cache HIT: retornar respuesta cacheada como Observable
      return of(new HttpResponse({
        body: cachedResponse,
        status: 200,
        statusText: 'OK (from cache)',
        url: req.url
      }));
    }

    // Cache MISS: proceder con la petición de red
    return next.handle(req).pipe(
      tap(event => {
        // Solo cachear respuestas HTTP exitosas
        if (event instanceof HttpResponse && event.status === 200) {
          // Guardar en caché
          this.cachingService.set(cacheKey, event.body);
        }
      })
    );
  }
}
