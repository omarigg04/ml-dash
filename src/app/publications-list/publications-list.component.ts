import { Component, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Router } from '@angular/router';
import { environment } from '../../environments/environment';
import { CachingService } from '../services/caching.service';
import { ChartThemeService } from '../services/chart-theme.service';
import { BulkMode } from './bulk-dialogs/bulk-dialogs.component';
import { PublicationsTableComponent } from './publications-table/publications-table.component';
import { Publication, intFmt, money } from './publication.model';

interface EditableItem {
  id: string;
  title: string;
  status: string;
  price: number;
  available_quantity: number;
  variations: { id: number; label: string; available_quantity: number; price: number }[];
  description: string;
  locks: { price?: string; stock?: string; description?: string };
  notes: string[];
}

interface EditChange { label: string; before: string; after: string; }

interface DayVisits { date: string; label: string; visits: number; }
interface StockRow { id: string; title: string; permalink: string; stock: number; pct: number; }

@Component({
  selector: 'app-publications-list',
  templateUrl: './publications-list.component.html',
  styleUrls: ['./publications-list.component.scss']
})
export class PublicationsListComponent implements OnInit, OnDestroy {
  @ViewChild(PublicationsTableComponent) table?: PublicationsTableComponent;

  // Subtítulo: total real que informa el backend (con el filtro actual)
  total: number | null = null;
  totalFiltered = false;

  // Aviso de resultado de Republicar / Editar
  notice: { kind: 'ok' | 'error'; text: string } | null = null;

  // Acciones masivas (modales)
  bulkMode: BulkMode = null;
  bulkItems: Publication[] = [];

  // Visitas por día (cuenta completa)
  days: DayVisits[] = [];
  daysTotal = 0;
  daysLoading = true;
  daysError = false;
  chartOptions: any = {};
  private offTheme?: () => void;

  // Stock por agotarse
  stockRows: StockRow[] = [];
  stockLoading = true;
  stockError = false;
  private stockRequested = false;

  // Confirmación de Republicar
  relistTarget: Publication | null = null;
  relistPrice = '';
  relistQty = '';
  isRelisting = false;

  // Editar (panel lateral)
  editTarget: Publication | null = null;
  editData: EditableItem | null = null;
  editLoading = false;
  editLoadError = '';
  editPrice: string | number = '';
  editQty: string | number = '';
  editVarQty: Record<string, string | number> = {};
  editDesc = '';
  editStep: 'form' | 'review' = 'form';
  isSaving = false;
  editErrors: string[] = [];

  readonly money = money;
  readonly int = intFmt;

  constructor(
    private http: HttpClient,
    private router: Router,
    private cachingService: CachingService,
    private chartTheme: ChartThemeService
  ) {}

  ngOnInit(): void {
    this.loadDays();
    this.offTheme = this.chartTheme.onChange(theme => {
      this.chartOptions = { ...this.chartOptions, theme };
    });
  }

  ngOnDestroy(): void {
    this.offTheme?.();
  }

  get subtitle(): string {
    if (this.total == null) return 'Cargando publicaciones…';
    const n = intFmt(this.total);
    return this.totalFiltered ? `${n} publicaciones con los filtros actuales` : `${n} publicaciones`;
  }

  onTableLoaded(ev: { total: number; filtered: boolean }): void {
    this.total = ev.total;
    this.totalFiltered = ev.filtered;
    // La lista de stock reutiliza la misma carga cacheada del backend: se pide después de la primera tabla
    if (!this.stockRequested) {
      this.stockRequested = true;
      this.refreshStockList();
    }
  }

  exportCsv(): void { this.table?.exportCsv(); }
  readonly exportTitle = 'Exporta a CSV solo las filas visibles de la página actual, no todas las publicaciones';

  // ---- Visitas por día ----
  loadDays(): void {
    this.daysLoading = true;
    this.daysError = false;
    this.http.get<{ total: number; results: { date: string; total: number }[] }>(
      `${environment.apiUrl}/items/visits/daily`, { params: new HttpParams().set('last', '30') }
    ).subscribe({
      next: res => {
        this.days = res.results.map(r => ({
          date: r.date.slice(0, 10),
          label: String(Number(r.date.slice(8, 10))),
          visits: r.total
        }));
        this.daysTotal = res.results.reduce((a, r) => a + r.total, 0);
        this.daysLoading = false;
        this.buildChart();
      },
      error: err => {
        console.error('Error loading daily visits:', err);
        this.daysLoading = false;
        this.daysError = true;
      }
    });
  }

  private buildChart(): void {
    const fmtDate = (iso: string) => new Date(iso + 'T12:00:00').toLocaleDateString('es-MX', { day: 'numeric', month: 'short' });
    this.chartOptions = {
      data: this.days,
      theme: this.chartTheme.current,
      background: { fill: 'transparent' },
      padding: { top: 8, right: 4, bottom: 10, left: 0 },
      series: [{
        type: 'bar', xKey: 'label', yKey: 'visits', yName: 'Visitas', strokeWidth: 0, cornerRadius: 2,
        tooltip: { renderer: (p: any) => ({ title: fmtDate(p.datum.date), content: intFmt(p.datum.visits) + ' visitas' }) }
      }],
      axes: [
        { type: 'category', position: 'bottom', label: { autoRotate: false, fontSize: 11 }, gridLine: { enabled: false } },
        { type: 'number', position: 'left', label: { formatter: (p: any) => intFmt(p.value) } }
      ],
      legend: { enabled: false }
    };
  }

  get chartLabel(): string {
    return `Visitas por día de toda la cuenta, últimos ${this.days.length} días: ${intFmt(this.daysTotal)} en total.`;
  }

  fmtDay(iso: string): string {
    return new Date(iso + 'T12:00:00').toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short' });
  }

  // ---- Stock por agotarse ----
  refreshStockList(): void {
    this.stockLoading = true;
    this.stockError = false;
    const params = new HttpParams().set('status', 'active').set('sort', 'stock_asc').set('min_sales', '1').set('limit', '5');
    this.http.get<{ items: Publication[] }>(`${environment.apiUrl}/items`, { params }).subscribe({
      next: res => {
        const max = Math.max(1, ...res.items.map(i => i.available_quantity));
        this.stockRows = res.items.map(i => ({
          id: i.id, title: i.title, permalink: i.permalink, stock: i.available_quantity,
          pct: Math.max(4, Math.round((i.available_quantity / max) * 100))
        }));
        this.stockLoading = false;
      },
      error: err => {
        console.error('Error loading low stock:', err);
        this.stockLoading = false;
        this.stockError = true;
      }
    });
  }

  // ---- Acciones masivas ----
  openBulk(mode: BulkMode, items: Publication[]): void {
    this.bulkItems = items;
    this.bulkMode = mode;
  }

  closeBulk(): void {
    this.bulkMode = null;
    this.bulkItems = [];
  }

  onBulkItemUpdated(ev: { id: string; patch: Partial<Publication> }): void {
    this.table?.patchRow(ev.id, ev.patch);
    this.refreshStockList();
  }

  // ---- Acciones por fila ----
  onDuplicateMany(item: Publication): void {
    this.router.navigate(['/publications/cargas-masivas'], { queryParams: { from: item.id } });
  }

  onDuplicate(item: Publication): void {
    this.router.navigate(['/publish'], { queryParams: { mode: 'duplicate', from: item.id } });
  }

  // ---- Editar: precio, stock y descripción ----
  openEdit(item: Publication): void {
    this.editTarget = item;
    this.editData = null;
    this.editLoadError = '';
    this.editErrors = [];
    this.editStep = 'form';
    this.isSaving = false;
    this.editLoading = true;
    this.http.get<EditableItem>(`${environment.apiUrl}/items/${item.id}/editable`).subscribe({
      next: data => {
        if (this.editTarget?.id !== item.id) return;
        this.editData = data;
        this.editPrice = String(data.price ?? '');
        this.editQty = String(data.available_quantity ?? '');
        this.editVarQty = {};
        data.variations.forEach(v => (this.editVarQty[v.id] = String(v.available_quantity ?? 0)));
        this.editDesc = data.description ?? '';
        this.editLoading = false;
      },
      error: err => {
        this.editLoading = false;
        this.editLoadError = err.error?.error || 'No se pudo cargar la publicación desde Mercado Libre.';
      }
    });
  }

  closeEdit(): void {
    if (this.isSaving) return;
    this.editTarget = null;
    this.editData = null;
  }

  get editHasVars(): boolean {
    return !!this.editData && this.editData.variations.length > 0;
  }

  get editAllLocked(): boolean {
    const l = this.editData?.locks;
    return !!l && !!l.price && !!l.stock && !!l.description;
  }

  private parsePrice(): number { return this.num(this.editPrice); }
  private num(v: unknown): number { return v == null || String(v).trim() === '' ? NaN : Number(v); }
  private parseQty(v: unknown): number { return this.num(v); }

  /** Errores de validación por campo (solo de campos editables) */
  get editFieldErrors(): { price?: string; qty?: string; vars: Record<string, string> } {
    const out: { price?: string; qty?: string; vars: Record<string, string> } = { vars: {} };
    const d = this.editData;
    if (!d) return out;
    const p = this.parsePrice();
    if (!d.locks.price && !(Number.isFinite(p) && p >= 0.01 && p <= 99999999)) out.price = 'Ingresa un precio entre $0.01 y $99,999,999.';
    if (!d.locks.stock) {
      if (this.editHasVars) {
        d.variations.forEach(v => {
          const q = this.parseQty(this.editVarQty[v.id]);
          if (!(Number.isInteger(q) && q >= 0 && q <= 99999)) out.vars[v.id] = 'Entero entre 0 y 99,999.';
        });
      } else {
        const q = this.parseQty(this.editQty);
        if (!(Number.isInteger(q) && q >= 0 && q <= 99999)) out.qty = 'Ingresa un entero entre 0 y 99,999.';
      }
    }
    return out;
  }

  get editHasFieldErrors(): boolean {
    const e = this.editFieldErrors;
    return !!e.price || !!e.qty || Object.keys(e.vars).length > 0;
  }

  /** Diferencias entre lo cargado y lo editado */
  get editChanges(): EditChange[] {
    const d = this.editData;
    if (!d) return [];
    const out: EditChange[] = [];
    if (!d.locks.price && this.parsePrice() !== d.price) {
      out.push({ label: 'Precio', before: money(d.price), after: money(this.parsePrice()) });
    }
    if (!d.locks.stock) {
      if (this.editHasVars) {
        d.variations.forEach(v => {
          const q = this.parseQty(this.editVarQty[v.id]);
          if (q !== v.available_quantity) out.push({ label: `Stock · ${v.label}`, before: intFmt(v.available_quantity), after: intFmt(q) });
        });
      } else if (this.parseQty(this.editQty) !== d.available_quantity) {
        out.push({ label: 'Stock', before: intFmt(d.available_quantity), after: intFmt(this.parseQty(this.editQty)) });
      }
    }
    if (!d.locks.description && this.editDesc !== d.description) {
      out.push({ label: 'Descripción', before: d.description || '(vacía)', after: this.editDesc || '(vacía)' });
    }
    return out;
  }

  reviewEdit(): void {
    this.editErrors = [];
    if (this.editHasFieldErrors || this.editChanges.length === 0) return;
    this.editStep = 'review';
  }

  backToForm(): void {
    if (this.isSaving) return;
    this.editStep = 'form';
    this.editErrors = [];
  }

  confirmEdit(): void {
    const d = this.editData;
    const item = this.editTarget;
    if (!d || !item || this.isSaving || this.editHasFieldErrors) return;
    const body: any = {};
    if (!d.locks.price && this.parsePrice() !== d.price) body.price = this.parsePrice();
    if (!d.locks.stock) {
      if (this.editHasVars) {
        const vars = d.variations
          .filter(v => this.parseQty(this.editVarQty[v.id]) !== v.available_quantity)
          .map(v => ({ id: v.id, available_quantity: this.parseQty(this.editVarQty[v.id]) }));
        if (vars.length) body.variations = vars;
      } else if (this.parseQty(this.editQty) !== d.available_quantity) {
        body.available_quantity = this.parseQty(this.editQty);
      }
    }
    if (!d.locks.description && this.editDesc !== d.description) body.description = this.editDesc;
    if (Object.keys(body).length === 0) return;

    this.isSaving = true;
    this.editErrors = [];
    this.http.put<any>(`${environment.apiUrl}/items/${item.id}`, body).subscribe({
      next: res => {
        this.isSaving = false;
        this.cachingService.invalidatePattern(/\/items(\?|$)/);
        this.applyUpdated(item.id, res?.updated);
        this.editTarget = null;
        this.editData = null;
        this.notice = { kind: 'ok', text: `Cambios guardados en ${item.id}.` };
      },
      error: err => {
        this.isSaving = false;
        const e = err.error;
        this.editStep = 'form';
        if (err.status === 207 && e) {
          // El item se guardó pero la descripción falló
          this.editErrors = ['Se guardaron precio/stock, pero la descripción no se pudo guardar.', ...this.errorLines(e.description)];
          this.refreshEditBase(item);
          return;
        }
        this.editErrors = this.errorLines(e);
      }
    });
  }

  private errorLines(e: any): string[] {
    if (!e) return ['No se pudo guardar. Inténtalo de nuevo.'];
    const causes: string[] = (e.causes || []).map((c: any) => c.message || c.code).filter(Boolean);
    return causes.length ? causes : [e.error || 'No se pudo guardar. Inténtalo de nuevo.'];
  }

  /** Tras un guardado parcial, vuelve a cargar los valores base del panel */
  private refreshEditBase(item: Publication): void {
    this.http.get<EditableItem>(`${environment.apiUrl}/items/${item.id}/editable`).subscribe({
      next: data => {
        if (this.editTarget?.id !== item.id) return;
        this.editData = data;
        this.editPrice = String(data.price ?? '');
        this.editQty = String(data.available_quantity ?? '');
        this.applyUpdated(item.id, { price: data.price, available_quantity: data.available_quantity });
      }
    });
  }

  private applyUpdated(id: string, u?: { price?: number; available_quantity?: number; status?: string; last_updated?: string }): void {
    if (!u) return;
    const patch: Partial<Publication> = {};
    if (u.price !== undefined) patch.price = u.price;
    if (u.available_quantity !== undefined) patch.available_quantity = u.available_quantity;
    if (u.status !== undefined) patch.status = u.status;
    if (u.last_updated !== undefined) patch.last_updated = u.last_updated;
    this.table?.patchRow(id, patch);
    this.refreshStockList();
  }

  // Relist: solo publicaciones finalizadas, con confirmación
  openRelist(item: Publication): void {
    if (item.status !== 'closed') return;
    this.relistTarget = item;
    this.relistPrice = String(item.price);
    this.relistQty = String(item.available_quantity);
    this.isRelisting = false;
  }

  cancelRelist(): void {
    if (this.isRelisting) return;
    this.relistTarget = null;
  }

  get relistValid(): boolean {
    return parseFloat(this.relistPrice) > 0 && parseInt(this.relistQty, 10) > 0;
  }

  confirmRelist(): void {
    const item = this.relistTarget;
    if (!item || !this.relistValid || this.isRelisting) return;
    this.isRelisting = true;
    this.http.post(`${environment.apiUrl}/items/${item.id}/relist`, {
      price: parseFloat(this.relistPrice),
      quantity: parseInt(this.relistQty, 10),
      listing_type_id: item.listing_type_id
    }).subscribe({
      next: (response: any) => {
        this.isRelisting = false;
        this.relistTarget = null;
        this.notice = { kind: 'ok', text: `Publicación republicada. Nuevo ID: ${response?.newItem?.id ?? ''}` };
        this.table?.reload();
      },
      error: (error) => {
        this.isRelisting = false;
        this.relistTarget = null;
        this.notice = { kind: 'error', text: this.errorLines(error.error).join(' ') || 'No se pudo republicar' };
      }
    });
  }
}
