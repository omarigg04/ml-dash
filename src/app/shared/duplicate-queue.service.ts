import { Injectable } from '@angular/core';

const KEY = 'ml_dup_queue';

/** Cola mínima para duplicar varias publicaciones una por una (sessionStorage, nunca publica nada). */
@Injectable({ providedIn: 'root' })
export class DuplicateQueueService {
  start(ids: string[]): void {
    sessionStorage.setItem(KEY, JSON.stringify(ids));
  }

  private read(): string[] {
    try {
      const v = JSON.parse(sessionStorage.getItem(KEY) || '[]');
      return Array.isArray(v) ? v.filter(x => typeof x === 'string') : [];
    } catch { return []; }
  }

  /** Posición del item en la cola (null si no hay cola o no pertenece a ella). */
  position(id: string): { index: number; total: number; nextId: string | null } | null {
    const q = this.read();
    const i = q.indexOf(id);
    if (q.length < 2 || i < 0) return null;
    return { index: i + 1, total: q.length, nextId: q[i + 1] ?? null };
  }

  clear(): void {
    sessionStorage.removeItem(KEY);
  }
}
