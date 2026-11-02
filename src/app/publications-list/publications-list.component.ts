import { Component, OnDestroy, OnInit } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { ActivatedRoute, Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { CellClickedEvent, ColDef, GetRowIdParams, ICellRendererParams } from 'ag-grid-community';
import { environment } from '../../environments/environment';
import { UserPreferencesService, PublicationFilters } from '../services/user-preferences.service';
import { CachingService } from '../services/caching.service';
import { GRID_LOCALE_ES } from '../shared/grid-locale';

interface Publication {
  id: string;
  title: string;
  price: number;
  available_quantity: number;
  sold_quantity?: number; // Número de ventas del producto
  status: string;
  thumbnail: string | null;
  listing_type_id: string;
  condition: string;
  permalink: string;
  date_created: string;
  last_updated: string;
  fullData: any;
  visits?: number; // Número de visitas del producto
}

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

interface PagingInfo {
  total: number;
  offset: number;
  limit: number;
}

type Tone = 'success' | 'warning' | 'info' | 'error' | 'off';

// Estados de publicación traducidos; lo desconocido se muestra tal cual con tono neutro.
const ITEM_STATUS: Record<string, { label: string; tone: Tone }> = {
  active: { label: 'Activa', tone: 'success' },
  paused: { label: 'Pausada', tone: 'warning' },
  closed: { label: 'Finalizada', tone: 'off' },
  under_review: { label: 'En revisión', tone: 'info' },
  inactive: { label: 'Inactiva', tone: 'off' },
};

const LISTING_TYPES: Record<string, string> = {
  gold_special: 'Clásica',
  gold_pro: 'Premium',
  free: 'Gratuita',
};

const escapeHtml = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

@Component({
  selector: 'app-publications-list',
  templateUrl: './publications-list.component.html',
  styleUrls: ['./publications-list.component.scss']
})
export class PublicationsListComponent implements OnInit, OnDestroy {
  dataSource: Publication[] = [];
  isLoading = false;
  isLoadingMore = false;
  isLoadingVisits = false;
  loadError = false;
  loadMoreError = false;

  // Móvil: el panel de filtros se colapsa tras el botón "Filtros"
  filtersOpen = false;

  // Aviso de resultado de Republicar
  notice: { kind: 'ok' | 'error'; text: string } | null = null;

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

  readonly skeletonRows = [1, 2, 3, 4, 5, 6, 7];
  readonly localeText = { ...GRID_LOCALE_ES, noRowsToShow: 'Sin publicaciones para mostrar' };

  // Filters
  searchQuery = '';
  statusFilter = '';
  listingTypeFilter = '';
  sortBy = '';

  // Pagination
  currentPage = 0;
  pageSize = 50;
  totalItems = 0;
  hasMore = false;

  // Filter options
  statusOptions = [
    { value: '', label: 'Todas' },
    { value: 'active', label: 'Activas' },
    { value: 'paused', label: 'Pausadas' },
    { value: 'closed', label: 'Finalizadas' },
    { value: 'under_review', label: 'En revisión' },
    { value: 'inactive', label: 'Inactivas' }
  ];

  listingTypeOptions = [
    { value: '', label: 'Todos los tipos' },
    { value: 'gold_special', label: 'Clásica' },
    { value: 'gold_pro', label: 'Premium' },
    { value: 'free', label: 'Gratuita' }
  ];

  sortOptions = [
    { value: '', label: 'Más relevantes' },
    { value: 'date_desc', label: 'Más recientes' },
    { value: 'date_asc', label: 'Más antiguos' },
    { value: 'price_asc', label: 'Menor precio' },
    { value: 'price_desc', label: 'Mayor precio' },
    { value: 'sales_desc', label: 'Más vendidos' },
    { value: 'sales_asc', label: 'Menos vendidos' },
    { value: 'title_asc', label: 'Título A-Z' },
    { value: 'title_desc', label: 'Título Z-A' },
    { value: 'stock_asc', label: 'Menor stock' },
    { value: 'stock_desc', label: 'Mayor stock' }
  ];

  // Orden del servidor (selector "Ordenar"); el orden por columna del grid se desactiva
  // para no ordenar solo la parte cargada.
  defaultColDef: ColDef = { sortable: false, resizable: true, suppressMovable: true };
  columnDefs: ColDef[] = [];
  getRowId = (p: GetRowIdParams) => p.data.id;

  private querySub?: Subscription;
  private searchTimer: any;

  constructor(
    private http: HttpClient,
    private router: Router,
    private route: ActivatedRoute,
    private userPreferencesService: UserPreferencesService,
    private cachingService: CachingService
  ) {
    const num: ColDef = { cellClass: 'ds-num', headerClass: 'ag-right-aligned-header', type: 'rightAligned' };
    this.columnDefs = [
      {
        headerName: 'Publicación',
        field: 'title',
        flex: 1,
        minWidth: 220,
        cellRenderer: (p: ICellRendererParams) => {
          const item: Publication = p.data;
          const thumb = item.thumbnail
            ? `<img class="pub-thumb" src="${escapeHtml(item.thumbnail)}" alt="" loading="lazy">`
            : `<span class="pub-thumb pub-thumb-empty" aria-hidden="true"></span>`;
          return `<span class="pub-cell">${thumb}<span class="pub-title-wrap"><a class="pub-title" href="${escapeHtml(item.permalink)}" target="_blank" rel="noopener" title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</a><span class="pub-id">${escapeHtml(item.id)}</span></span></span>`;
        },
      },
      { headerName: 'Precio', field: 'price', width: 105, valueFormatter: p => this.money(p.value), ...num },
      { headerName: 'Disp.', field: 'available_quantity', headerTooltip: 'Disponible', width: 80, valueFormatter: p => this.int(p.value), ...num },
      { headerName: 'Vendidos', field: 'sold_quantity', width: 90, valueFormatter: p => this.int(p.value ?? 0), ...num },
      {
        headerName: 'Visitas',
        field: 'visits',
        width: 85,
        valueFormatter: p => (p.value == null ? (this.isLoadingVisits ? '…' : '0') : this.int(p.value)),
        ...num,
      },
      {
        headerName: 'Conv.',
        colId: 'conv',
        headerTooltip: 'Conversión: vendidos / visitas',
        width: 80,
        valueGetter: p => this.conversion(p.data),
        valueFormatter: p => (p.value == null ? '—' : this.pct(p.value)),
        ...num,
      },
      {
        headerName: 'Ingreso',
        colId: 'revenue',
        headerTooltip: 'Precio × vendidos',
        width: 120,
        valueGetter: p => this.revenue(p.data),
        valueFormatter: p => this.money(p.value),
        ...num,
      },
      {
        headerName: 'Estado',
        field: 'status',
        width: 110,
        cellRenderer: (p: ICellRendererParams) => {
          const info = this.statusInfo(p.value);
          return `<span class="ds-badge tone-${info.tone}">${escapeHtml(info.label)}</span>`;
        },
      },
      { headerName: 'Tipo', field: 'listing_type_id', width: 95, valueFormatter: p => this.listingLabel(p.value) },
      {
        headerName: 'Acciones',
        colId: 'actions',
        width: 235,
        sortable: false,
        cellRenderer: (p: ICellRendererParams) => {
          const relist = p.data.status === 'closed'
            ? `<button type="button" class="ds-btn row-btn" data-action="relist">Republicar</button>` : '';
          const edit = p.data.status !== 'closed'
            ? `<button type="button" class="ds-btn row-btn" data-action="edit">Editar</button>` : '';
          return `<span class="row-actions">${edit}<button type="button" class="ds-btn row-btn" data-action="duplicate">Duplicar</button>${relist}</span>`;
        },
      },
    ];
  }

  async ngOnInit(): Promise<void> {
    // Cargar preferencias guardadas antes de cargar publicaciones
    await this.loadSavedPreferences();
    // Búsqueda global de la topbar: /publications?q=texto (también cuando ya estás en la pantalla)
    this.querySub = this.route.queryParamMap.subscribe(params => {
      this.searchQuery = params.get('q') ?? '';
      this.loadPublications();
    });
  }

  ngOnDestroy(): void {
    this.querySub?.unsubscribe();
    clearTimeout(this.searchTimer);
  }

  /**
   * Carga las preferencias de filtros guardadas
   * Nota: NO carga el término de búsqueda (siempre inicia vacío)
   */
  private async loadSavedPreferences(): Promise<void> {
    try {
      const savedFilters = await this.userPreferencesService.getPublicationFilters();
      if (savedFilters) {
        this.statusFilter = savedFilters.statusFilter || '';
        this.listingTypeFilter = savedFilters.listingTypeFilter || '';
        this.sortBy = savedFilters.sortBy || '';
      }
    } catch (error) {
      console.error('Error al cargar preferencias:', error);
    }
  }

  private async saveCurrentFilters(): Promise<void> {
    try {
      const filters: PublicationFilters = {
        searchQuery: '', // No guardar búsqueda - es temporal
        statusFilter: this.statusFilter,
        listingTypeFilter: this.listingTypeFilter,
        sortBy: this.sortBy
      };
      await this.userPreferencesService.savePublicationFilters(filters);
    } catch (error) {
      console.error('Error al guardar preferencias:', error);
    }
  }

  /**
   * Load publications with current filters (parámetros al backend sin cambios)
   */
  loadPublications(reset: boolean = true): void {
    if (reset) {
      this.dataSource = [];
      this.currentPage = 0;
      this.loadError = false;
    }
    this.loadMoreError = false;

    this.isLoading = reset;
    this.isLoadingMore = !reset;

    const params = new HttpParams()
      .set('offset', (this.currentPage * this.pageSize).toString())
      .set('limit', this.pageSize.toString())
      .set('status', this.statusFilter)
      .set('listing_type', this.listingTypeFilter)
      .set('q', this.searchQuery)
      .set('sort', this.sortBy);

    this.http.get<{items: Publication[], paging: PagingInfo}>(`${environment.apiUrl}/items`, { params })
      .subscribe({
        next: (response) => {
          this.dataSource = reset ? response.items : [...this.dataSource, ...response.items];
          this.totalItems = response.paging.total;
          this.hasMore = (response.paging.offset + response.paging.limit) < response.paging.total;
          this.isLoading = false;
          this.isLoadingMore = false;
          this.loadVisits(response.items);
        },
        error: (error) => {
          console.error('Error loading publications:', error);
          if (reset) this.loadError = true; else this.loadMoreError = true;
          if (!reset) this.currentPage--;
          this.isLoading = false;
          this.isLoadingMore = false;
        }
      });
  }

  /**
   * Load visit counts for items
   */
  loadVisits(items: Publication[]): void {
    if (!items || items.length === 0) return;

    this.isLoadingVisits = true;
    const itemIds = items.map(item => item.id).join(',');

    this.http.get<{[key: string]: number}>(`${environment.apiUrl}/items/visits`, {
      params: new HttpParams().set('ids', itemIds)
    }).subscribe({
      next: (visitsData) => {
        this.dataSource = this.dataSource.map(item => ({ ...item, visits: visitsData[item.id] || 0 }));
        this.isLoadingVisits = false;
      },
      error: (error) => {
        console.error('Error loading visits:', error);
        this.dataSource = this.dataSource.map(item => ({ ...item, visits: 0 }));
        this.isLoadingVisits = false;
      }
    });
  }

  loadMore(): void {
    if (!this.hasMore || this.isLoadingMore) return;
    this.currentPage++;
    this.loadPublications(false);
  }

  // ---- Buscador ----
  onSearchInput(value: string): void {
    this.searchQuery = value;
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.onSearch(), 400);
  }

  onSearch(): void {
    clearTimeout(this.searchTimer);
    this.loadPublications(true);
  }

  clearSearch(): void {
    this.searchQuery = '';
    // Si venía de ?q=, límpialo de la URL (la suscripción recarga)
    if (this.route.snapshot.queryParamMap.has('q')) {
      this.router.navigate([], { queryParams: {}, replaceUrl: true });
    } else {
      this.loadPublications(true);
    }
  }

  // ---- Filtros ----
  setStatus(value: string): void {
    this.statusFilter = value;
    this.loadPublications(true);
    this.saveCurrentFilters();
  }

  onListingTypeFilterChange(): void {
    this.loadPublications(true);
    this.saveCurrentFilters();
  }

  onSortChange(): void {
    this.loadPublications(true);
    this.saveCurrentFilters();
  }

  clearFilters(): void {
    this.searchQuery = '';
    this.statusFilter = '';
    this.listingTypeFilter = '';
    this.sortBy = '';
    if (this.route.snapshot.queryParamMap.has('q')) {
      this.router.navigate([], { queryParams: {}, replaceUrl: true });
    } else {
      this.loadPublications(true);
    }
    this.saveCurrentFilters();
  }

  /** Filtros que acotan resultados (el orden no cuenta) */
  hasActiveFilters(): boolean {
    return !!(this.searchQuery || this.statusFilter || this.listingTypeFilter);
  }

  get activeFilterCount(): number {
    return [this.statusFilter, this.listingTypeFilter, this.sortBy].filter(Boolean).length;
  }

  // ---- Acciones ----
  // Duplicate: Navigate to publish form with pre-filled data (sin cambios)
  onDuplicate(item: Publication): void {
    this.router.navigate(['/publish'], {
      queryParams: { mode: 'duplicate', from: item.id }
    });
  }

  onCellClicked(event: CellClickedEvent): void {
    const btn = (event.event?.target as HTMLElement | null)?.closest('button[data-action]') as HTMLElement | null;
    if (!btn) return;
    if (btn.dataset['action'] === 'duplicate') this.onDuplicate(event.data);
    if (btn.dataset['action'] === 'relist') this.openRelist(event.data);
    if (btn.dataset['action'] === 'edit') this.openEdit(event.data);
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
      out.push({ label: 'Precio', before: this.money(d.price), after: this.money(this.parsePrice()) });
    }
    if (!d.locks.stock) {
      if (this.editHasVars) {
        d.variations.forEach(v => {
          const q = this.parseQty(this.editVarQty[v.id]);
          if (q !== v.available_quantity) out.push({ label: `Stock · ${v.label}`, before: this.int(v.available_quantity), after: this.int(q) });
        });
      } else if (this.parseQty(this.editQty) !== d.available_quantity) {
        out.push({ label: 'Stock', before: this.int(d.available_quantity), after: this.int(this.parseQty(this.editQty)) });
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
    this.dataSource = this.dataSource.map(it => it.id === id ? {
      ...it,
      price: u.price ?? it.price,
      available_quantity: u.available_quantity ?? it.available_quantity,
      status: u.status ?? it.status,
      last_updated: u.last_updated ?? it.last_updated
    } : it);
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
        this.loadPublications();
      },
      error: (error) => {
        this.isRelisting = false;
        this.relistTarget = null;
        this.notice = { kind: 'error', text: error.error?.details || 'No se pudo republicar' };
      }
    });
  }

  // ---- Presentación ----
  statusInfo(status: string): { label: string; tone: Tone } {
    return ITEM_STATUS[status] ?? { label: status || '—', tone: 'off' };
  }

  listingLabel(id: string): string {
    return LISTING_TYPES[id] ?? id ?? '—';
  }

  money(v: number | null | undefined): string {
    return v == null ? '' : Number(v).toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });
  }

  conversion(item: Publication): number | null {
    return item.visits ? (item.sold_quantity || 0) / item.visits : null;
  }

  revenue(item: Publication): number {
    return (item.price || 0) * (item.sold_quantity || 0);
  }

  pct(v: number): string {
    return (v * 100).toLocaleString('es-MX', { maximumFractionDigits: 1 }) + '%';
  }

  int(v: number | null | undefined): string {
    return v == null ? '' : Number(v).toLocaleString('es-MX');
  }

  trackById(_: number, item: Publication): string {
    return item.id;
  }
}
