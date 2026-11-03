import { Component, ElementRef, EventEmitter, Input, OnChanges, Output, SimpleChanges, ViewChild } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../../environments/environment';
import { CachingService } from '../../services/caching.service';
import { DuplicateQueueService } from '../../shared/duplicate-queue.service';
import { Publication, ITEM_STATUS, errorReason, money, runPool } from '../publication.model';

export type BulkMode = 'pause' | 'price' | 'duplicate' | null;

type RowState = 'loading' | 'ready' | 'skip' | 'running' | 'ok' | 'error';
interface BulkRow {
  item: Publication;
  state: RowState;
  /** Motivo de omisión o error de ML */
  note?: string;
  /** Precio fresco leído de /editable (solo Editar precio) */
  current?: number;
  /** Precio nuevo enviado (solo Editar precio) */
  after?: number;
}
interface Plan { kind: 'send' | 'same' | 'invalid' | 'skip' | 'loading'; after?: number; note?: string; }

const CONCURRENCY = 3;

@Component({
  selector: 'app-bulk-dialogs',
  templateUrl: './bulk-dialogs.component.html',
  styleUrls: ['./bulk-dialogs.component.scss']
})
export class BulkDialogsComponent implements OnChanges {
  @Input() mode: BulkMode = null;
  @Input() items: Publication[] = [];
  @Output() closed = new EventEmitter<void>();
  /** Cambios confirmados por el backend, para refrescar la fila sin recargar */
  @Output() itemUpdated = new EventEmitter<{ id: string; patch: Partial<Publication> }>();

  @ViewChild('dialog') dialog?: ElementRef<HTMLElement>;

  rows: BulkRow[] = [];
  step: 'confirm' | 'running' | 'done' = 'confirm';

  // Editar precio
  priceMode: 'fixed' | 'percent' = 'percent';
  priceValue = '';

  readonly money = money;

  constructor(
    private http: HttpClient,
    private router: Router,
    private cache: CachingService,
    private queue: DuplicateQueueService
  ) {}

  ngOnChanges(ch: SimpleChanges): void {
    if (!ch['mode'] && !ch['items']) return;
    if (!this.mode) return;
    this.step = 'confirm';
    this.priceValue = '';
    this.priceMode = 'percent';
    if (this.mode === 'pause') {
      this.rows = this.items.map(item => item.status === 'active'
        ? { item, state: 'ready' as RowState }
        : { item, state: 'skip' as RowState, note: `Se omite: no está activa (${this.statusLabel(item.status)})` });
    } else if (this.mode === 'price') {
      this.rows = this.items.map(item => ({ item, state: 'loading' as RowState }));
      this.loadLocks();
    } else {
      this.rows = this.items.map(item => ({ item, state: 'ready' as RowState }));
    }
    setTimeout(() => this.dialog?.nativeElement.focus());
  }

  statusLabel(s: string): string { return ITEM_STATUS[s]?.label ?? s; }

  get title(): string {
    return this.mode === 'pause' ? 'Pausar publicaciones'
      : this.mode === 'price' ? 'Editar precio' : 'Duplicar publicaciones';
  }

  close(): void {
    if (this.step === 'running') return;
    this.closed.emit();
  }

  get sendable(): BulkRow[] {
    return this.mode === 'price'
      ? this.rows.filter(r => this.plan(r).kind === 'send')
      : this.rows.filter(r => r.state === 'ready');
  }
  get skipped(): number { return this.rows.length - this.sendable.length; }
  get okCount(): number { return this.rows.filter(r => r.state === 'ok').length; }
  get errCount(): number { return this.rows.filter(r => r.state === 'error').length; }

  // ---------- Pausar ----------
  async confirmPause(): Promise<void> {
    const targets = this.rows.filter(r => r.state === 'ready');
    if (!targets.length) return;
    this.step = 'running';
    targets.forEach(r => (r.state = 'running'));
    await runPool(targets, CONCURRENCY, async r => {
      try {
        const res: any = await firstValueFrom(this.http.put(`${environment.apiUrl}/items/${r.item.id}`, { status: 'paused' }));
        r.state = 'ok';
        this.itemUpdated.emit({ id: r.item.id, patch: { status: res?.updated?.status ?? 'paused' } });
      } catch (err) {
        r.state = 'error';
        r.note = errorReason(err);
      }
    });
    this.afterRun();
  }

  // ---------- Editar precio ----------
  /** Lee /editable (GET) de cada item para respetar bloqueos (promociones, finalizadas, variantes). */
  private async loadLocks(): Promise<void> {
    const rows = this.rows;
    await runPool(rows, CONCURRENCY, async r => {
      try {
        const d: any = await firstValueFrom(this.http.get(`${environment.apiUrl}/items/${r.item.id}/editable`));
        if (this.rows !== rows) return; // se cerró o cambió la selección
        r.current = d.price;
        if (d.locks?.price) { r.state = 'skip'; r.note = `Se omite: ${d.locks.price}`; }
        else if (d.variations?.length) { r.state = 'skip'; r.note = 'Se omite: tiene variantes, edita el precio por variante.'; }
        else r.state = 'ready';
      } catch (err) {
        r.state = 'skip';
        r.note = `Se omite: no se pudo verificar la publicación (${errorReason(err)})`;
      }
    });
  }

  get priceInputValid(): boolean {
    const n = Number(this.priceValue);
    return String(this.priceValue).trim() !== '' && Number.isFinite(n) && (this.priceMode === 'fixed' ? n > 0 : n > -100);
  }

  plan(r: BulkRow): Plan {
    if (r.state === 'loading') return { kind: 'loading' };
    if (r.state === 'skip') return { kind: 'skip', note: r.note };
    if (r.state !== 'ready') return { kind: 'skip' };
    if (!this.priceInputValid || r.current == null) return { kind: 'invalid' };
    const n = Number(this.priceValue);
    const after = this.priceMode === 'fixed' ? n : Math.round(r.current * (1 + n / 100) * 100) / 100;
    if (!(after >= 0.01 && after <= 99999999)) return { kind: 'invalid', note: 'Precio fuera de rango (0.01 – 99,999,999)' };
    if (after === r.current) return { kind: 'same', after, note: 'Sin cambio' };
    return { kind: 'send', after };
  }

  async confirmPrice(): Promise<void> {
    const targets = this.rows.filter(r => this.plan(r).kind === 'send');
    if (!targets.length) return;
    const afters = new Map(targets.map(r => [r.item.id, this.plan(r).after as number]));
    this.step = 'running';
    targets.forEach(r => { r.after = afters.get(r.item.id); r.state = 'running'; });
    await runPool(targets, CONCURRENCY, async r => {
      try {
        const res: any = await firstValueFrom(this.http.put(`${environment.apiUrl}/items/${r.item.id}`, { price: afters.get(r.item.id) }));
        r.state = 'ok';
        this.itemUpdated.emit({ id: r.item.id, patch: { price: res?.updated?.price ?? afters.get(r.item.id) } });
      } catch (err) {
        r.state = 'error';
        r.note = errorReason(err);
      }
    });
    this.afterRun();
  }

  private afterRun(): void {
    this.cache.invalidatePattern(/\/items(\?|$)/);
    this.step = 'done';
  }

  // ---------- Duplicar (nunca publica: solo abre el formulario) ----------
  openDuplicateForm(): void {
    const ids = this.items.map(i => i.id);
    if (!ids.length) return;
    if (ids.length > 1) this.queue.start(ids); else this.queue.clear();
    this.closed.emit();
    this.router.navigate(['/publish'], { queryParams: { mode: 'duplicate', from: ids[0] } });
  }
}
