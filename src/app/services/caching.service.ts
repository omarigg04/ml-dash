import { Injectable } from '@angular/core';
import { environment } from '../../environments/environment';

/**
 * Estructura de una entrada en el caché
 */
interface CacheEntry {
  data: any;
  expiry: number;
  timestamp: number;
}

/**
 * Configuración de TTL (Time To Live) por endpoint
 */
interface CacheConfig {
  ttl: number;  // en segundos
  pattern: RegExp;
}

@Injectable({
  providedIn: 'root'
})
export class CachingService {
  private readonly CACHE_PREFIX = 'ml_cache_v1_';
  private readonly DEFAULT_TTL = 300; // 5 minutos por defecto

  /**
   * URLs que NUNCA deben ser cacheadas
   */
  private readonly BLACKLIST_PATTERNS: RegExp[] = [
    /\/auth/i,           // Endpoints de autenticación
    /\/login/i,          // Login
    /\/logout/i,         // Logout
    /\/session/i,        // Sesiones
    /\/verify/i,         // Verificaciones
    /\/debug/i,          // Debug endpoints
  ];

  /**
   * Configuración de TTL personalizado por endpoint
   * Los endpoints con datos que cambian menos frecuentemente pueden tener TTL más largo
   */
  private readonly CACHE_CONFIGS: CacheConfig[] = [
    { pattern: /\/orders/i, ttl: 180 },           // 3 minutos - pedidos cambian frecuentemente
    { pattern: /\/items/i, ttl: 300 },            // 5 minutos - items cambian moderadamente
    { pattern: /\/categories/i, ttl: 3600 },      // 1 hora - categorías casi nunca cambian
    { pattern: /\/gallery/i, ttl: 600 },          // 10 minutos - galería cambia ocasionalmente
    { pattern: /\/chart/i, ttl: 600 },            // 10 minutos - datos de gráfica
    { pattern: /\/publications/i, ttl: 240 },     // 4 minutos - publicaciones
  ];

  /** Datos personales (pedidos con compradores): solo en memoria, nunca en localStorage */
  private readonly MEMORY_ONLY_PATTERNS: RegExp[] = [/\/orders/i];
  private readonly memory = new Map<string, CacheEntry>();

  private isMemoryOnly(key: string): boolean {
    return this.MEMORY_ONLY_PATTERNS.some(p => p.test(key));
  }

  constructor() {
    this.cleanExpiredEntries();
  }

  /**
   * Verifica si una URL está en la blacklist
   */
  private isBlacklisted(url: string): boolean {
    return this.BLACKLIST_PATTERNS.some(pattern => pattern.test(url));
  }

  /**
   * Obtiene el TTL apropiado para una URL
   */
  private getTTL(url: string): number {
    const config = this.CACHE_CONFIGS.find(c => c.pattern.test(url));
    return config ? config.ttl : this.DEFAULT_TTL;
  }

  /**
   * Genera una clave única para el caché
   */
  private getCacheKey(key: string): string {
    return this.CACHE_PREFIX + key;
  }

  /**
   * Obtiene datos del caché si existen y son válidos
   */
  get(key: string): any | null {
    // Si está en blacklist, no cachear
    if (this.isBlacklisted(key)) {
      this.log('🚫 URL en blacklist, no cachear:', key);
      return null;
    }

    if (this.isMemoryOnly(key)) {
      const entry = this.memory.get(key);
      if (!entry) return null;
      if (Date.now() > entry.expiry) {
        this.memory.delete(key);
        return null;
      }
      return entry.data;
    }

    try {
      const cacheKey = this.getCacheKey(key);
      const item = localStorage.getItem(cacheKey);

      if (!item) {
        this.log('❌ Caché no encontrado para:', key);
        return null;
      }

      const entry: CacheEntry = JSON.parse(item);
      const now = Date.now();

      // Verificar si ha expirado
      if (now > entry.expiry) {
        this.log('⏰ Caché expirado para:', key);
        this.invalidate(key);
        return null;
      }

      const age = Math.round((now - entry.timestamp) / 1000);
      const remaining = Math.round((entry.expiry - now) / 1000);
      this.log(`✅ Caché HIT para: ${key} (edad: ${age}s, resta: ${remaining}s)`);

      return entry.data;

    } catch (error) {
      this.logError('Error al leer del caché:', error);
      return null;
    }
  }

  /**
   * Guarda datos en el caché con TTL
   */
  set(key: string, data: any, ttl_seconds?: number): void {
    // Si está en blacklist, no cachear
    if (this.isBlacklisted(key)) {
      return;
    }

    if (this.isMemoryOnly(key)) {
      const ttl = ttl_seconds || this.getTTL(key);
      const now = Date.now();
      this.memory.set(key, { data, expiry: now + ttl * 1000, timestamp: now });
      return;
    }

    try {
      const ttl = ttl_seconds || this.getTTL(key);
      const now = Date.now();
      const expiry = now + (ttl * 1000);

      const entry: CacheEntry = {
        data,
        expiry,
        timestamp: now
      };

      const cacheKey = this.getCacheKey(key);
      const serialized = JSON.stringify(entry);

      // Verificar tamaño aproximado
      const sizeKB = new Blob([serialized]).size / 1024;
      if (sizeKB > 500) {
        this.log(`⚠️ Entrada grande (${sizeKB.toFixed(2)} KB) para: ${key}`);
      }

      localStorage.setItem(cacheKey, serialized);
      this.log(`💾 Caché guardado para: ${key} (TTL: ${ttl}s)`);

    } catch (error: any) {
      // Si localStorage está lleno, intentar limpiar entradas antiguas
      if (error.name === 'QuotaExceededError') {
        this.logError('⚠️ localStorage lleno, limpiando entradas expiradas...');
        this.cleanExpiredEntries();

        // Intentar de nuevo después de limpiar
        try {
          const ttl = ttl_seconds || this.getTTL(key);
          const entry: CacheEntry = {
            data,
            expiry: Date.now() + (ttl * 1000),
            timestamp: Date.now()
          };
          localStorage.setItem(this.getCacheKey(key), JSON.stringify(entry));
          this.log(`💾 Caché guardado después de limpieza: ${key}`);
        } catch (retryError) {
          this.logError('❌ No se pudo guardar en caché después de limpieza:', retryError);
        }
      } else {
        this.logError('Error al guardar en caché:', error);
      }
    }
  }

  /**
   * Invalida una entrada específica del caché
   */
  invalidate(key: string): void {
    this.memory.delete(key);
    try {
      const cacheKey = this.getCacheKey(key);
      localStorage.removeItem(cacheKey);
      this.log(`🗑️ Caché invalidado para: ${key}`);
    } catch (error) {
      this.logError('Error al invalidar caché:', error);
    }
  }

  /**
   * Invalida múltiples entradas que coincidan con un patrón
   */
  invalidatePattern(pattern: RegExp): void {
    Array.from(this.memory.keys()).filter(k => pattern.test(k)).forEach(k => this.memory.delete(k));
    try {
      const keys = this.getAllCacheKeys();
      let count = 0;

      keys.forEach(key => {
        if (pattern.test(key)) {
          this.invalidate(key);
          count++;
        }
      });

      this.log(`🗑️ ${count} entradas invalidadas con patrón: ${pattern}`);
    } catch (error) {
      this.logError('Error al invalidar por patrón:', error);
    }
  }

  /**
   * Limpia todo el caché de la aplicación
   */
  invalidateAll(): void {
    this.memory.clear();
    try {
      const keys = this.getAllCacheKeys();
      keys.forEach(key => this.invalidate(key));
      this.log(`🗑️ Todo el caché limpiado (${keys.length} entradas)`);
    } catch (error) {
      this.logError('Error al limpiar todo el caché:', error);
    }
  }

  /**
   * Logout: borra caché, imágenes locales, catálogo y borradores de publicación.
   * Se conservan solo preferencias no sensibles (tema).
   */
  clearAllUserData(): void {
    this.invalidateAll();
    try {
      ['mlImageGallery', 'mlImageCatalog', 'mlImageCatalogTimestamp'].forEach(k => localStorage.removeItem(k));
      const toRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && (k.startsWith('publish-draft:') || k.startsWith(this.CACHE_PREFIX))) toRemove.push(k);
      }
      toRemove.forEach(k => localStorage.removeItem(k));
      sessionStorage.removeItem('ml_dup_queue');
      localStorage.removeItem('ml_dash_publication_filters');
    } catch { /* almacenamiento no disponible */ }
  }

  /**
   * Obtiene todas las claves del caché
   */
  private getAllCacheKeys(): string[] {
    const keys: string[] = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(this.CACHE_PREFIX)) {
          // Remover el prefijo para obtener la clave original
          keys.push(key.substring(this.CACHE_PREFIX.length));
        }
      }
    } catch (error) {
      this.logError('Error al obtener claves del caché:', error);
    }
    return keys;
  }

  /**
   * Limpia entradas expiradas del caché
   */
  cleanExpiredEntries(): void {
    try {
      const keys = this.getAllCacheKeys();
      const now = Date.now();
      let cleaned = 0;

      keys.forEach(key => {
        try {
          const cacheKey = this.getCacheKey(key);
          const item = localStorage.getItem(cacheKey);
          if (item) {
            const entry: CacheEntry = JSON.parse(item);
            if (now > entry.expiry) {
              localStorage.removeItem(cacheKey);
              cleaned++;
            }
          }
        } catch (error) {
          // Si hay error al parsear, eliminar la entrada corrupta
          localStorage.removeItem(this.getCacheKey(key));
          cleaned++;
        }
      });

      if (cleaned > 0) {
        this.log(`🧹 ${cleaned} entradas expiradas limpiadas`);
      }
    } catch (error) {
      this.logError('Error al limpiar entradas expiradas:', error);
    }
  }

  /**
   * Obtiene estadísticas del caché
   */
  getStats(): { total: number; size: string; entries: any[] } {
    const keys = this.getAllCacheKeys();
    const entries: any[] = [];
    let totalSize = 0;

    keys.forEach(key => {
      try {
        const cacheKey = this.getCacheKey(key);
        const item = localStorage.getItem(cacheKey);
        if (item) {
          const size = new Blob([item]).size;
          totalSize += size;

          const entry: CacheEntry = JSON.parse(item);
          const now = Date.now();
          const age = Math.round((now - entry.timestamp) / 1000);
          const remaining = Math.round((entry.expiry - now) / 1000);

          entries.push({
            key,
            sizeKB: (size / 1024).toFixed(2),
            age: `${age}s`,
            remaining: remaining > 0 ? `${remaining}s` : 'expirado',
            expired: now > entry.expiry
          });
        }
      } catch (error) {
        // Ignorar errores en entradas individuales
      }
    });

    return {
      total: keys.length,
      size: `${(totalSize / 1024).toFixed(2)} KB`,
      entries: entries.sort((a, b) => parseInt(b.sizeKB) - parseInt(a.sizeKB))
    };
  }

  /**
   * Log para desarrollo
   */
  private log(message: string, ...args: any[]): void {
    if (!environment.production) {
      console.log(`[CachingService] ${message}`, ...args);
    }
  }

  /**
   * Log de errores
   */
  private logError(message: string, error?: any): void {
    if (!environment.production) {
      console.error(`[CachingService] ${message}`, error);
    }
  }
}
