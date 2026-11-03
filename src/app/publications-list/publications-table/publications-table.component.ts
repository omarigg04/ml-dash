import { Component, ElementRef, EventEmitter, HostListener, Input, OnChanges, OnDestroy, OnInit, Output, QueryList, SimpleChanges, ViewChild, ViewChildren } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { ActivatedRoute, Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { environment } from '../../../environments/environment';
import { csvCell } from '../../shared/csv';
import { UserPreferencesService } from '../../services/user-preferences.service';
import {
  ITEM_STATUS, LISTING_TYPES, LOW_STOCK, PagingInfo, Publication, HEADER_SORT_OPTIONS, SORT_OPTIONS, STATUS_OPTIONS, Tone,
  conversion, intFmt, money, pctFmt, revenue
} from '../publication.model';

type MenuKind = 'status' | 'add' | 'view' | 'row' | 'page';
interface MenuState { kind: MenuKind; x: number; y: number; item?: Publication; stockInput?: boolean; }

const PAGE_SIZES = [10, 25, 50];

/**
 * Tabla de publicaciones (HTML semántico). Modo completo: toolbar de filtros, selección, paginación real y
 * menú "⋯" por fila. Modo compacto: N filas fijas ordenadas por ventas, sin toolbar ni selección
 * (para reutilizarla en Inicio).
 */
@Component({
  selector: 'app-publications-table',
  templateUrl: './publications-table.component.html',
  styleUrls: ['./publications-table.component.scss']
})
export class PublicationsTableComponent implements OnInit, OnChanges, OnDestroy {
  @Input() compact = false;
  @Input() compactRows = 5;

  @Output() editRow = new EventEmitter<Publication>();
  @Output() relistRow = new EventEmitter<Publication>();
  @Output() duplicateRow = new EventEmitter<Publication>();
  @Output() bulkPause = new EventEmitter<Publication[]>();
  @Output() bulkPrice = new EventEmitter<Publication[]>();
  @Output() bulkDuplicate = new EventEmitter<Publication[]>();
  /** Total real del filtro actual (el que informa el backend) */
  @Output() loaded = new EventEmitter<{ total: number; filtered: boolean }>();

  @ViewChild('menuEl') menuEl?: ElementRef<HTMLElement>;
  @ViewChildren('stockInputEl') stockInputEl?: QueryList<ElementRef<HTMLInputElement>>;

  rows: Publication[] = [];
  isLoading = false;
  loadError = false;
  isLoadingVisits = false;
  total = 0;

  // Filtros
  searchQuery = '';
  statusFilter = 'active';
  listingTypeFilter = '';
  maxStock: number | null = null;
  noSales = false;
  noVisits = false; // solo sobre las filas cargadas (ML no ofrece este filtro)
  sortBy = 'sales_desc';
  stockDraft = '20';

  // Paginación
  page = 0;
  pageSize = 10;
  readonly pageSizes = PAGE_SIZES;

  // Selección (se conserva al paginar)
  selected = new Map<string, Publication>();

  // Móvil
  filtersOpen = false;

  menu: MenuState | null = null;
  private menuTrigger: HTMLElement | null = null;

  readonly statusOptions = STATUS_OPTIONS;
  readonly sortOptions = SORT_OPTIONS;
  readonly lowStock = LOW_STOCK;
  readonly skeletonRows = [1, 2, 3, 4, 5, 6, 7];

  readonly money = money;
  readonly int = intFmt;
  readonly pct = pctFmt;
  readonly conversion = conversion;
  readonly revenue = revenue;

  private querySub?: Subscription;
  private searchTimer: any;
  private reqSeq = 0;

  constructor(
    private http: HttpClient,
    private router: Router,
    private route: ActivatedRoute,
    private prefs: UserPreferencesService,
    private host: ElementRef<HTMLElement>
  ) {}

  async ngOnInit(): Promise<void> {
    document.addEventListener('scroll', this.onScroll, true);
    if (this.compact) {
      this.pageSize = this.compactRows;
      this.load();
      return;
    }
    await this.loadPrefs();
    // Búsqueda global de la topbar: /publications?q=texto (también cuando ya estás en la pantalla)
    this.querySub = this.route.queryParamMap.subscribe(params => {
      this.searchQuery = params.get('q') ?? '';
      this.page = 0;
      this.load();
    });
  }

  ngOnChanges(ch: SimpleChanges): void {
    if (this.compact && (ch['compactRows'] && !ch['compactRows'].firstChange)) {
      this.pageSize = this.compactRows;
      this.load();
    }
  }

  ngOnDestroy(): void {
    document.removeEventListener('scroll', this.onScroll, true);
    this.querySub?.unsubscribe();
    clearTimeout(this.searchTimer);
  }

  // ---------- Preferencias (se descartan valores viejos que ya no existen) ----------
  private async loadPrefs(): Promise<void> {
    const saved = await this.prefs.getPublicationFilters();
    if (!saved) return;
    // "Todas" no se recuerda: al entrar se parte de Activas salvo que se haya elegido otro estado
    if (saved.statusFilter && STATUS_OPTIONS.some(o => o.value === saved.statusFilter)) this.statusFilter = saved.statusFilter;
    if (saved.listingTypeFilter === 'gold_special' || saved.listingTypeFilter === 'gold_pro') this.listingTypeFilter = saved.listingTypeFilter;
    // El antiguo "Más relevantes" ('') pasa a la vista por defecto
    this.sortBy = [...SORT_OPTIONS, ...HEADER_SORT_OPTIONS].some(o => o.value === saved.sortBy) ? saved.sortBy : 'sales_desc';
    if (PAGE_SIZES.includes(saved.pageSize as number)) this.pageSize = saved.pageSize as number;
    if (typeof saved.maxStock === 'number' && saved.maxStock >= 0) this.maxStock = saved.maxStock;
    this.noSales = saved.noSales === true;
  }

  private savePrefs(): void {
    if (this.compact) return;
    this.prefs.savePublicationFilters({
      searchQuery: '', statusFilter: this.statusFilter, listingTypeFilter: this.listingTypeFilter,
      sortBy: this.sortBy, pageSize: this.pageSize, maxStock: this.maxStock, noSales: this.noSales
    }).catch(e => console.error('Error al guardar preferencias:', e));
  }

  // ---------- Carga ----------
  load(): void {
    const seq = ++this.reqSeq;
    this.isLoading = true;
    this.loadError = false;
    let params = new HttpParams()
      .set('offset', String(this.page * this.pageSize))
      .set('limit', String(this.pageSize))
      .set('sort', this.compact || this.isLocalSort ? 'sales_desc' : this.sortBy);
    // Inicio resume lo que está a la venta hoy; lo pausado se ve en Publicaciones
    if (this.compact) params = params.set('status', 'active');
    if (!this.compact) {
      if (this.statusFilter) params = params.set('status', this.statusFilter);
      if (this.listingTypeFilter) params = params.set('listing_type', this.listingTypeFilter);
      if (this.searchQuery) params = params.set('q', this.searchQuery);
      if (this.maxStock != null) params = params.set('max_stock', String(this.maxStock));
      if (this.noSales) params = params.set('no_sales', '1');
    }
    this.http.get<{ items: Publication[]; paging: PagingInfo }>(`${environment.apiUrl}/items`, { params }).subscribe({
      next: res => {
        if (seq !== this.reqSeq) return;
        this.rows = res.items.map(i => ({ ...i, visits: undefined }));
        this.total = res.paging.total;
        this.isLoading = false;
        this.loaded.emit({ total: this.total, filtered: this.hasServerFilters });
        this.loadVisits(seq);
      },
      error: err => {
        if (seq !== this.reqSeq) return;
        console.error('Error loading publications:', err);
        this.rows = [];
        this.isLoading = false;
        this.loadError = true;
      }
    });
  }

  private loadVisits(seq: number): void {
    if (this.rows.length === 0) return;
    this.isLoadingVisits = true;
    const ids = this.rows.map(r => r.id).join(',');
    this.http.get<Record<string, number | null>>(`${environment.apiUrl}/items/visits`, { params: new HttpParams().set('ids', ids) })
      .subscribe({
        next: data => {
          if (seq !== this.reqSeq) return;
          this.rows = this.rows.map(r => ({ ...r, visits: data[r.id] === undefined ? null : data[r.id] }));
          this.isLoadingVisits = false;
        },
        error: err => {
          if (seq !== this.reqSeq) return;
          console.error('Error loading visits:', err);
          this.rows = this.rows.map(r => ({ ...r, visits: null }));
          this.isLoadingVisits = false;
        }
      });
  }

  reload(): void { this.load(); }

  /** Actualiza una fila en memoria (tras editar/pausar) sin recargar. */
  patchRow(id: string, patch: Partial<Publication>): void {
    this.rows = this.rows.map(r => r.id === id ? { ...r, ...patch } : r);
    const s = this.selected.get(id);
    if (s) this.selected.set(id, { ...s, ...patch });
  }

  // ---------- Vista de filas ----------
  /** Filas visibles: "Sin visitas" se aplica solo sobre las cargadas y con visitas reales (0). */
  get visibleRows(): Publication[] {
    const rows = this.noVisits ? this.rows.filter(r => r.visits === 0) : this.rows;
    if (!this.isLocalSort) return rows;
    const [key, dir] = this.sortBy.split('_');
    const val = (r: Publication) => (key === 'visits' ? r.visits ?? null : conversion(r));
    // Sin dato (visitas sin cargar, conversión "—") siempre al final
    return [...rows].sort((a, b) => {
      const x = val(a), y = val(b);
      if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1;
      return dir === 'asc' ? x - y : y - x;
    });
  }

  /** Visitas y conversión no existen en el listado del servidor: ordenan solo la página cargada. */
  get isLocalSort(): boolean { return /^(visits|conv)_/.test(this.sortBy); }

  get hasServerFilters(): boolean {
    return !!(this.statusFilter || this.listingTypeFilter || this.searchQuery || this.maxStock != null || this.noSales);
  }

  get hasAnyFilter(): boolean {
    return this.statusFilter !== 'active' || !!(this.listingTypeFilter || this.searchQuery || this.maxStock != null || this.noSales || this.noVisits);
  }

  get rangeLabel(): string {
    if (this.noVisits) {
      return `${this.visibleRows.length} de ${this.rows.length} de esta página (filtro "Sin visitas": ${this.isLoadingVisits ? 'cargando visitas…' : 'solo filas cargadas'})`;
    }
    if (this.total === 0) return '0 de 0';
    const from = this.page * this.pageSize + 1;
    const to = this.page * this.pageSize + this.rows.length;
    return `${intFmt(from)}–${intFmt(to)} de ${intFmt(this.total)}`;
  }

  get hasPrev(): boolean { return this.page > 0; }
  get hasNext(): boolean { return (this.page + 1) * this.pageSize < this.total; }

  prev(): void { if (this.hasPrev && !this.isLoading) { this.page--; this.load(); } }
  next(): void { if (this.hasNext && !this.isLoading) { this.page++; this.load(); } }

  setPageSize(v: string): void {
    this.pageSize = Number(v);
    this.page = 0;
    this.savePrefs();
    this.load();
  }

  // ---------- Filtros ----------
  get statusLabel(): string { return this.statusOptions.find(o => o.value === this.statusFilter)?.label ?? 'Todas'; }
  get sortLabel(): string { return [...this.sortOptions, ...HEADER_SORT_OPTIONS].find(o => o.value === this.sortBy)?.label ?? 'Por ventas'; }
  get typeLabel(): string { return LISTING_TYPES[this.listingTypeFilter] ?? ''; }

  private filtersChanged(): void {
    this.page = 0;
    this.selected.clear();
    this.savePrefs();
    this.load();
  }

  onSearchInput(value: string): void {
    this.searchQuery = value;
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.onSearch(), 400);
  }

  onSearch(): void {
    clearTimeout(this.searchTimer);
    this.page = 0;
    this.selected.clear();
    this.load();
  }

  clearSearch(): void {
    this.searchQuery = '';
    if (this.route.snapshot.queryParamMap.has('q')) {
      this.router.navigate([], { queryParams: {}, replaceUrl: true }); // la suscripción recarga
    } else {
      this.onSearch();
    }
  }

  setStatus(v: string): void { this.statusFilter = v; this.closeMenu(); this.filtersChanged(); }
  setSort(v: string): void { this.sortBy = v; this.closeMenu(); this.filtersChanged(); }

  isSort(key: string): boolean { return this.sortBy.startsWith(key + '_'); }
  ariaSort(key: string): string {
    if (!this.isSort(key)) return 'none';
    return this.sortBy.endsWith('_asc') ? 'ascending' : 'descending';
  }
  get sortIcon(): string { return this.sortBy.endsWith('_asc') ? 'expand_less' : 'expand_more'; }

  /** Primer clic: A-Z en texto, mayor a menor en números. Segundo clic: invierte. */
  toggleSort(key: string): void {
    if (this.compact) return;
    const first = key === 'title' || key === 'status' ? 'asc' : 'desc';
    const other = first === 'asc' ? 'desc' : 'asc';
    const wasLocal = this.isLocalSort;
    this.sortBy = this.sortBy === `${key}_${first}` ? `${key}_${other}` : `${key}_${first}`;
    // Entre visitas y conversión la página ya está cargada: no se vuelve a pedir
    if (this.isLocalSort && wasLocal) { this.savePrefs(); return; }
    this.filtersChanged();
  }

  setType(v: string): void { this.listingTypeFilter = v; this.closeMenu(); this.filtersChanged(); }
  removeType(): void { this.listingTypeFilter = ''; this.filtersChanged(); }

  applyStock(): void {
    const n = Number(this.stockDraft);
    if (!Number.isFinite(n) || n < 1) return;
    this.maxStock = Math.floor(n);
    this.closeMenu();
    this.filtersChanged();
  }
  removeStock(): void { this.maxStock = null; this.filtersChanged(); }

  setNoSales(on: boolean): void { this.noSales = on; this.closeMenu(); this.filtersChanged(); }
  setNoVisits(on: boolean): void { this.noVisits = on; this.closeMenu(); this.selected.clear(); }

  clearAllFilters(): void {
    this.statusFilter = 'active'; this.listingTypeFilter = ''; this.maxStock = null; this.noSales = false; this.noVisits = false;
    this.searchQuery = '';
    if (this.route.snapshot.queryParamMap.has('q')) {
      this.router.navigate([], { queryParams: {}, replaceUrl: true });
      this.savePrefs();
    } else {
      this.filtersChanged();
    }
  }

  // ---------- Selección ----------
  isSelected(r: Publication): boolean { return this.selected.has(r.id); }
  get selectedItems(): Publication[] { return Array.from(this.selected.values()); }
  get allVisibleSelected(): boolean { return this.visibleRows.length > 0 && this.visibleRows.every(r => this.selected.has(r.id)); }
  get someVisibleSelected(): boolean { return this.visibleRows.some(r => this.selected.has(r.id)) && !this.allVisibleSelected; }

  toggleRow(r: Publication): void {
    if (this.selected.has(r.id)) this.selected.delete(r.id); else this.selected.set(r.id, r);
  }

  toggleAll(): void {
    if (this.allVisibleSelected) this.visibleRows.forEach(r => this.selected.delete(r.id));
    else this.visibleRows.forEach(r => this.selected.set(r.id, r));
  }

  clearSelection(): void { this.selected.clear(); }

  // ---------- Menús (una sola capa fija para no quedar recortada por el scroll de la tabla) ----------
  openMenu(kind: MenuKind, ev: Event, item?: Publication): void {
    ev.stopPropagation();
    if (this.menu && this.menu.kind === kind && this.menu.item?.id === item?.id) { this.closeMenu(); return; }
    const trigger = ev.currentTarget as HTMLElement;
    const rect = trigger.getBoundingClientRect();
    const width = 200;
    const x = Math.max(8, Math.min(kind === 'row' || kind === 'view' || kind === 'page' ? rect.right - width : rect.left, window.innerWidth - width - 8));
    this.menuTrigger = trigger;
    this.menu = { kind, x, y: rect.bottom + 4, item };
    setTimeout(() => { this.flipIfOffscreen(rect); this.focusMenuItem(0); });
  }

  /** Si el menú no cabe debajo del botón (p. ej. el pie de la tabla), se abre hacia arriba. */
  private flipIfOffscreen(rect: DOMRect): void {
    const el = this.menuEl?.nativeElement;
    if (!el || !this.menu) return;
    const h = el.offsetHeight;
    if (this.menu.y + h > window.innerHeight - 8) {
      this.menu = { ...this.menu, y: Math.max(8, rect.top - h - 4) };
    }
  }

  closeMenu(restoreFocus = true): void {
    if (!this.menu) return;
    this.menu = null;
    if (restoreFocus) this.menuTrigger?.focus();
  }

  private focusMenuItem(i: number): void {
    const items = this.menuEl?.nativeElement.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled]), input');
    if (!items || items.length === 0) return;
    items[(i + items.length) % items.length].focus();
  }

  onMenuKey(ev: KeyboardEvent): void {
    const items = Array.from(this.menuEl?.nativeElement.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled]), input') ?? []);
    const idx = items.indexOf(document.activeElement as HTMLElement);
    if (ev.key === 'ArrowDown') { ev.preventDefault(); this.focusMenuItem(idx + 1); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); this.focusMenuItem(idx - 1); }
    else if (ev.key === 'Escape') { ev.preventDefault(); this.closeMenu(); }
    else if (ev.key === 'Tab') { this.closeMenu(false); }
  }

  showStockInput(): void {
    if (!this.menu) return;
    this.menu = { ...this.menu, stockInput: true };
    setTimeout(() => this.stockInputEl?.first?.nativeElement.focus());
  }

  @HostListener('document:click', ['$event'])
  onDocClick(ev: MouseEvent): void {
    if (!this.menu) return;
    // composedPath: el botón pulsado puede haberse destruido ya al re-renderizar el menú
    if (this.menuEl && ev.composedPath().includes(this.menuEl.nativeElement)) return;
    this.closeMenu(false);
  }

  @HostListener('window:resize') onResize(): void { this.closeMenu(false); }
  /** El scroll ocurre en el contenedor del layout, no en window: se escucha en fase de captura. */
  private onScroll = (ev: Event): void => {
    if (this.menu && !(this.menuEl?.nativeElement.contains(ev.target as Node))) this.closeMenu(false);
  };

  rowAction(kind: 'edit' | 'duplicate' | 'relist', item: Publication): void {
    this.closeMenu(false);
    if (kind === 'edit') this.editRow.emit(item);
    if (kind === 'duplicate') this.duplicateRow.emit(item);
    if (kind === 'relist') this.relistRow.emit(item);
  }

  // ---------- Presentación ----------
  statusInfo(status: string): { label: string; tone: Tone } {
    return ITEM_STATUS[status] ?? { label: status || '—', tone: 'off' };
  }

  isLowStock(r: Publication): boolean { return r.available_quantity < LOW_STOCK; }

  initials(r: Publication): string {
    return (r.title || '?').replace(/[^\p{L}\p{N} ]/gu, '').trim().slice(0, 2).toUpperCase();
  }

  visitsLabel(r: Publication): string {
    if (r.visits === undefined) return '…';
    return r.visits === null ? '—' : intFmt(r.visits);
  }

  convLabel(r: Publication): string {
    const c = conversion(r);
    return c == null ? '—' : pctFmt(c);
  }

  trackById(_: number, r: Publication): string { return r.id; }

  get emptyTitle(): string { return this.hasAnyFilter ? 'Sin resultados con estos filtros' : 'Aún no tienes publicaciones'; }

  // ---------- Exportar CSV (solo las filas visibles de la página actual) ----------
  get exportTitle(): string {
    return `Exporta a CSV las ${this.visibleRows.length} filas visibles (solo la página cargada, no las ${intFmt(this.total)} publicaciones)`;
  }

  exportCsv(): void {
    const rows = this.visibleRows;
    const safe = csvCell;
    const head = ['ID', 'Título', 'Estado', 'Ventas', 'Precio', 'Stock', 'Visitas', 'Conversión', 'Ingreso aprox.', 'Enlace'];
    const lines = [head.map(safe).join(',')];
    for (const r of rows) {
      const c = conversion(r);
      lines.push([
        r.id, r.title, this.statusInfo(r.status).label, r.sold_quantity || 0, r.price, r.available_quantity,
        r.visits == null ? '' : r.visits, c == null ? '' : (c * 100).toFixed(2) + '%', revenue(r).toFixed(2), r.permalink
      ].map(safe).join(','));
    }
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `publicaciones-${new Date().toISOString().slice(0, 10)}.csv`;
    this.host.nativeElement.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
