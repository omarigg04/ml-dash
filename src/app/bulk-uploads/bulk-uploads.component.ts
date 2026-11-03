import { Component, ElementRef, HostListener, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute, Router } from '@angular/router';
import { firstValueFrom, Subscription } from 'rxjs';
import { environment } from '../../environments/environment';
import { AuthService } from '../services/auth.service';
import { CachingService } from '../services/caching.service';
import { MLImageUploadService } from '../services/ml-image-upload.service';
import {
  FALLBACK_MAX_PICTURES, ListingTemplateService, PackageForm, PayloadAttribute, VariationDraft
} from '../shared/listing-template.service';
import { CategoryAttribute } from '../services/category-predictor.service';
import {
  DUPLICATE_WARNING, MAX_COPIES, MAX_TITLE, MIN_COPIES, PUBLISH_GAP_MS, RowStatus, VALIDATE_CONCURRENCY,
  clampCopies, runPool, splitIssues, titleWarnings
} from './bulk-uploads.logic';

export interface ErrorCause { code: string; message: string; type?: string; }
export interface Photo { id: string; url: string; }
interface RowValidation { ok: boolean; errors: ErrorCause[]; warnings: ErrorCause[]; failed?: string; }

export interface BulkRow {
  key: number;
  familyName: string;
  titleEdited: boolean;
  aiNote: string;
  price: number | null;
  quantity: number | null;
  condition: 'new' | 'used';
  pictures: Photo[];
  status: RowStatus;
  itemId?: string;
  permalink?: string;
  error?: string;
  causes: ErrorCause[];
  descriptionState: 'none' | 'ok' | 'failed' | 'retrying';
  descriptionError?: string;
  descriptionText?: string;
  // Solo en memoria
  photosOpen?: boolean;
  photoError?: string;
  uploading?: boolean;
  validating?: boolean;
  validation?: RowValidation | null;
}

interface SearchHit { id: string; title: string; price: number; status: string; thumbnail?: string; available_quantity?: number; }

interface Template {
  sourceId: string;
  sourceStatus: string;
  originalFamilyName: string;
  categoryId: string;
  categoryName: string;
  categoryPath: string;
  maxPictures: number;
  condition: 'new' | 'used';
  listingTypeId: 'gold_special' | 'gold_pro';
  listingTypeNote: string;
  description: string;
  freeShipping: boolean;
  localPickUp: boolean;
  fulfillmentNote: string;
  warrantyType: string;
  warrantyTime: string;
  otherSaleTerms: PayloadAttribute[];
  pkg: PackageForm;
  categoryAttributes: CategoryAttribute[];
  attributeValues: { [k: string]: any };
  extraAttributes: PayloadAttribute[];
  gtin: string;
  emptyGtinReason: string;
  gtinReasons: Array<{ id: string; name: string }>;
  hasGtinAttr: boolean;
  skuCleared: boolean;
  variations: VariationDraft[];
  sourcePictures: Photo[];
  basePrice: number;
  baseQuantity: number;
  pictureNote: string;
}

type ModalKind = 'publish' | 'replace' | 'discard' | 'titles' | null;

const DRAFT_PREFIX = 'publish-draft:bulk:';
const DRAFT_VERSION = 1;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

@Component({
  selector: 'app-bulk-uploads',
  templateUrl: './bulk-uploads.component.html',
  styleUrls: ['./bulk-uploads.component.scss']
})
export class BulkUploadsComponent implements OnInit, OnDestroy {
  readonly maxCopies = MAX_COPIES;
  readonly minCopies = MIN_COPIES;
  readonly maxTitle = MAX_TITLE;
  readonly duplicateWarning = DUPLICATE_WARNING;

  // ---- Paso 1: origen y copias ----
  query = '';
  hits: SearchHit[] = [];
  searching = false;
  searchError = '';
  sourceId = '';
  sourceTitle = '';
  copies = 5;
  /** Variaciones del original elegido (solo si tiene) y la que se copiará al crear filas. */
  pickedVariations: VariationDraft[] = [];
  variationKey: number | string | null = null;
  /** Origen y variación con los que se crearon las filas actuales (pueden diferir de lo elegido arriba). */
  rowsSourceId = '';
  rowsSourceTitle = '';
  rowsVariationKey: number | string | null = null;
  loadingSource = false;
  sourceError = '';

  // ---- Plantilla compartida (heredada del original) ----
  tpl: Template | null = null;
  templateError = '';

  // ---- Filas ----
  rows: BulkRow[] = [];
  private nextKey = 1;
  draftRestored = false;
  draftUnavailable = false;

  // ---- Ayudas masivas ----
  bulkPrice: number | null = null;
  bulkStock: number | null = null;

  // ---- Títulos con IA ----
  titlesBusy = false;
  titlesMessage: { kind: 'ok' | 'warn' | 'error'; text: string } | null = null;
  titlesOverwrite = false;

  // ---- Validar / publicar ----
  validatingAll = false;
  publishing = false;
  stopRequested = false;
  modal: ModalKind = null;
  banner: { kind: 'ok' | 'warn' | 'error'; text: string } | null = null;

  // ---- Galería (selector por fila) ----
  galleryRow: BulkRow | null = null;
  galleryImages: Photo[] = [];

  @ViewChild('modalEl') modalEl?: ElementRef<HTMLElement>;

  private uid: string | null = null;
  private saveTimer: any = null;
  private destroyed = false;
  private subs = new Subscription();
  private queryTimer: any = null;

  constructor(
    private http: HttpClient,
    private route: ActivatedRoute,
    private router: Router,
    private auth: AuthService,
    private caching: CachingService,
    private upload: MLImageUploadService,
    private tplSvc: ListingTemplateService
  ) {}

  // =====================================================
  // Ciclo de vida
  // =====================================================

  async ngOnInit(): Promise<void> {
    this.uid = await this.resolveUid();
    if (!this.uid) { this.draftUnavailable = true; }
    const restored = this.restoreDraft();
    const from = this.route.snapshot.queryParamMap.get('from');
    if (restored && this.rowsSourceId) { await this.loadTemplate(this.rowsSourceId); }
    if (from && /^MLM\d+$/.test(from)) {
      await this.pickSource(from);          // preselecciona; no crea filas hasta pulsar "Crear filas"
    }
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    this.stopRequested = true;
    this.subs.unsubscribe();
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveNow(); }
    if (this.queryTimer) { clearTimeout(this.queryTimer); }
  }

  @HostListener('window:beforeunload', ['$event'])
  onBeforeUnload(ev: BeforeUnloadEvent): void {
    if (this.publishing) { ev.preventDefault(); ev.returnValue = ''; }
  }

  /** Cuenta actual: sin cuenta no se guarda ni se lee ningún borrador (falla cerrado). */
  private async resolveUid(): Promise<string | null> {
    let cur: any = null;
    this.auth.currentUser$.subscribe(v => { cur = v; }).unsubscribe();
    if (!cur) {
      try { await this.auth.checkSession(); } catch { /* sin sesión */ }
      this.auth.currentUser$.subscribe(v => { cur = v; }).unsubscribe();
    }
    return cur?.userId !== null && cur?.userId !== undefined ? String(cur.userId) : null;
  }

  private get draftKey(): string | null { return this.uid ? DRAFT_PREFIX + this.uid : null; }

  // =====================================================
  // Paso 1: buscar origen
  // =====================================================

  onQueryChange(): void {
    if (this.queryTimer) { clearTimeout(this.queryTimer); }
    this.queryTimer = setTimeout(() => this.search(), 400);
  }

  async search(): Promise<void> {
    const q = this.query.trim();
    this.searchError = '';
    if (q.length < 2) { this.hits = []; return; }
    this.searching = true;
    try {
      if (/^MLM\d+$/i.test(q)) {
        const it: any = await firstValueFrom(this.http.get<any>(`${environment.apiUrl}/items/${encodeURIComponent(q.toUpperCase())}`));
        this.hits = [this.toHit(it)];
      } else {
        const r: any = await firstValueFrom(this.http.get<any>(`${environment.apiUrl}/items`, { params: { q, limit: '8' } }));
        this.hits = (r.items || []).map((it: any) => this.toHit(it));
      }
    } catch (err) {
      this.hits = [];
      this.searchError = this.parseHttpError(err, 'No se pudo buscar').message;
    } finally {
      this.searching = false;
    }
  }

  private toHit(it: any): SearchHit {
    return { id: it.id, title: it.title, price: it.price, status: it.status, thumbnail: it.thumbnail, available_quantity: it.available_quantity };
  }

  async pickSource(id: string, title?: string): Promise<void> {
    this.sourceId = id;
    this.sourceError = '';
    this.hits = [];
    this.pickedVariations = [];
    this.variationKey = null;
    if (title) { this.sourceTitle = title; this.query = title; }
    try {
      const it: any = await firstValueFrom(this.http.get<any>(`${environment.apiUrl}/items/${encodeURIComponent(id)}`));
      this.sourceTitle = it.title || id;
      this.query = this.sourceTitle;
      this.pickedVariations = (it.variations || []).map((v: any, k: number) => this.tplSvc.mapVariation(v, k)).filter((v: VariationDraft) => v.include && !v.unresolved);
      this.variationKey = this.pickedVariations.length ? this.pickedVariations[0].key : null;
    } catch (err) {
      this.sourceTitle = title || id;
      this.sourceError = this.parseHttpError(err, 'No se pudo leer la publicación').message;
    }
  }

  clearSource(): void { this.sourceId = ''; this.sourceTitle = ''; this.query = ''; this.hits = []; this.pickedVariations = []; this.variationKey = null; }

  get hasPublishedRows(): boolean { return this.rows.some(r => r.status === 'published'); }

  /** "Crear filas": si ya hay filas se pide confirmar antes de reemplazarlas. */
  requestCreate(): void {
    if (!this.sourceId || this.loadingSource) { return; }
    this.copies = clampCopies(this.copies);
    if (this.rows.length > 0) { this.openModal('replace'); return; }
    this.createRows();
  }

  async createRows(): Promise<void> {
    this.closeModal();
    this.copies = clampCopies(this.copies);
    this.banner = null;
    const ok = await this.loadTemplate(this.sourceId, true);
    if (!ok || !this.tpl) { return; }
    this.rowsSourceId = this.sourceId;
    this.rowsSourceTitle = this.sourceTitle;
    this.rowsVariationKey = this.variationKey;
    this.nextKey = 1;
    this.draftRestored = false;
    this.titlesMessage = null;
    this.rows = Array.from({ length: this.copies }, () => this.newRow());
    this.saveNow();
  }

  /** Lee el original fresco y arma la plantilla heredada. Con `choose` también elige la variación. */
  private async loadTemplate(id: string, choose = false): Promise<boolean> {
    this.loadingSource = true;
    this.sourceError = '';
    this.templateError = '';
    try {
      const { item, description } = await this.tplSvc.fetchSource(id);
      const m = this.tplSvc.mapSourceItem(item, description);
      const pkg: PackageForm = { height: null, width: null, length: null, weight: null, weightUnit: 'g' };
      const h = this.tplSvc.hydrateAttributes(item.attributes || [], pkg);
      const ctx = await this.tplSvc.loadCategoryContext(m.categoryId);
      const r = this.tplSvc.resolveRawAttributes(Object.values(h.raw), ctx.displayedAttributes, ctx.allAttributes);
      const maxPictures = ctx.cat?.maxPictures || FALLBACK_MAX_PICTURES;
      const toPhoto = (p: any): Photo => ({ id: p.id, url: p.secure_url || p.url });
      if (choose) { this.rowsVariationKey = this.variationKey; }
      this.tpl = {
        sourceId: id, sourceStatus: m.sourceStatus, originalFamilyName: m.originalFamilyName,
        categoryId: m.categoryId, categoryName: ctx.cat?.name || '', categoryPath: ctx.cat?.path || '', maxPictures,
        condition: m.condition, listingTypeId: m.listingTypeId, listingTypeNote: m.listingTypeNote, description: m.description,
        freeShipping: m.freeShipping, localPickUp: m.localPickUp, fulfillmentNote: m.fulfillmentNote,
        warrantyType: m.warrantyType, warrantyTime: m.warrantyTime, otherSaleTerms: m.otherSaleTerms,
        pkg, categoryAttributes: ctx.displayedAttributes, attributeValues: r.values, extraAttributes: r.extra,
        gtin: h.gtin, emptyGtinReason: h.emptyGtinReason || '', gtinReasons: ctx.gtinReasons, hasGtinAttr: ctx.hasGtinAttr,
        skuCleared: h.skuCleared, variations: m.variations, sourcePictures: m.pictures.map(toPhoto),
        basePrice: m.price, baseQuantity: m.quantity,
        pictureNote: m.pictures.length > maxPictures ? `La categoría permite ${maxPictures} fotos y el original tiene ${m.pictures.length}: cada fila arranca con las primeras ${maxPictures}.` : '',
      };
      return true;
    } catch (err) {
      const msg = this.parseHttpError(err, 'No se pudo leer la publicación original').message;
      if (choose) { this.sourceError = msg; } else { this.templateError = msg; }
      if (choose) { this.tpl = null; }
      return false;
    } finally {
      this.loadingSource = false;
    }
  }

  retryTemplate(): void { if (this.rowsSourceId) { this.loadTemplate(this.rowsSourceId); } }

  // =====================================================
  // Filas
  // =====================================================

  /** Variación elegida (solo si el original tiene variaciones). */
  get chosenVariation(): VariationDraft | null {
    if (!this.tpl || !this.tpl.variations.length) { return null; }
    return this.tpl.variations.find(v => String(v.key) === String(this.rowsVariationKey) && v.include && !v.unresolved) ?? null;
  }

  get usableVariations(): VariationDraft[] { return (this.tpl?.variations || []).filter(v => v.include && !v.unresolved); }

  private newRow(): BulkRow {
    const t = this.tpl!;
    const v = this.chosenVariation;
    const ids = v && v.pictureIds.length ? v.pictureIds : t.sourcePictures.map(p => p.id);
    const pics = ids.map(id => t.sourcePictures.find(p => p.id === id)).filter((p): p is Photo => !!p).slice(0, t.maxPictures);
    return {
      key: this.nextKey++, familyName: t.originalFamilyName.slice(0, MAX_TITLE), titleEdited: false, aiNote: '',
      price: v ? v.price : t.basePrice, quantity: v ? (v.quantity || 1) : t.baseQuantity, condition: t.condition,
      pictures: pics, status: 'pending', causes: [], descriptionState: 'none'
    };
  }

  get canAddRow(): boolean { return !!this.tpl && this.rows.length < MAX_COPIES; }

  addRow(): void {
    if (!this.canAddRow) { return; }
    this.rows.push(this.newRow());
    this.changed();
  }

  duplicateRow(row: BulkRow): void {
    if (!this.canAddRow || row.status === 'published') { return; }
    const copy: BulkRow = {
      ...row, key: this.nextKey++, pictures: row.pictures.map(p => ({ ...p })), status: 'pending', itemId: undefined, permalink: undefined,
      error: undefined, causes: [], descriptionState: 'none', descriptionError: undefined, descriptionText: undefined,
      validation: null, photosOpen: false, photoError: undefined, uploading: false, validating: false
    };
    this.rows.splice(this.rows.indexOf(row) + 1, 0, copy);
    this.changed();
  }

  deleteRow(row: BulkRow): void {
    if (this.isLocked(row)) { return; }
    this.rows = this.rows.filter(r => r !== row);
    this.changed();
  }

  /** Publicada, enviándose o sin confirmar: no se edita ni se reenvía por accidente. */
  isLocked(row: BulkRow): boolean { return row.status === 'published' || row.status === 'publishing' || row.status === 'unconfirmed'; }

  onTitleInput(row: BulkRow): void { row.titleEdited = true; row.aiNote = ''; row.validation = null; this.changed(); }
  onEdit(row: BulkRow): void { row.validation = null; this.changed(); }

  applyToAll(): void {
    const price = Number(this.bulkPrice), qty = Number(this.bulkStock);
    this.rows.filter(r => !this.isLocked(r)).forEach(r => {
      if (this.bulkPrice !== null && price > 0) { r.price = price; }
      if (this.bulkStock !== null && Number.isInteger(qty) && qty >= 1) { r.quantity = qty; }
      r.validation = null;
    });
    this.changed();
  }

  get canApplyAll(): boolean {
    const p = this.bulkPrice !== null && Number(this.bulkPrice) > 0;
    const s = this.bulkStock !== null && Number.isInteger(Number(this.bulkStock)) && Number(this.bulkStock) >= 1;
    return (p || s) && this.rows.some(r => !this.isLocked(r));
  }

  // =====================================================
  // Fotos por fila
  // =====================================================

  get maxPictures(): number { return this.tpl?.maxPictures ?? FALLBACK_MAX_PICTURES; }

  togglePhotos(row: BulkRow): void { row.photosOpen = !row.photosOpen; }

  movePhoto(row: BulkRow, i: number, dir: number): void {
    const j = i + dir;
    if (this.isLocked(row) || j < 0 || j >= row.pictures.length) { return; }
    [row.pictures[i], row.pictures[j]] = [row.pictures[j], row.pictures[i]];
    this.onEdit(row);
  }

  makeMain(row: BulkRow, i: number): void {
    if (this.isLocked(row) || i <= 0) { return; }
    const [p] = row.pictures.splice(i, 1);
    row.pictures.unshift(p);
    this.onEdit(row);
  }

  removePhoto(row: BulkRow, i: number): void {
    if (this.isLocked(row)) { return; }
    row.pictures.splice(i, 1);
    this.onEdit(row);
  }

  async onFiles(row: BulkRow, ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    const files = Array.from(input.files || []);
    input.value = '';
    row.photoError = undefined;
    for (const f of files) {
      if (row.pictures.length >= this.maxPictures) { row.photoError = `Máximo ${this.maxPictures} fotos para esta categoría.`; break; }
      if (!f.type.startsWith('image/')) { row.photoError = `"${f.name}" no es una imagen.`; continue; }
      if (f.size > 4 * 1024 * 1024) { row.photoError = `"${f.name}" pesa más de 4 MB. Redúcela antes de subirla.`; continue; }
      row.uploading = true;
      try {
        const r = await this.upload.uploadImage(f);
        const url = r.variations?.[0]?.secure_url || r.variations?.[0]?.url || '';
        row.pictures.push({ id: r.id, url });
        this.onEdit(row);
      } catch (e: any) {
        row.photoError = `No se pudo subir "${f.name}": ${e?.message || 'error'}`;
      } finally {
        row.uploading = false;
      }
    }
  }

  openGallery(row: BulkRow): void {
    this.galleryRow = row;
    this.galleryImages = this.readGallery();
    this.openModalFocus();
  }

  /** Misma fuente que image-source-selector: galería subida a mano + catálogo sincronizado. */
  private readGallery(): Photo[] {
    const out = new Map<string, Photo>();
    const read = (key: string, f: (x: any) => Photo | null) => {
      try {
        const arr = JSON.parse(localStorage.getItem(key) || '[]');
        if (Array.isArray(arr)) { arr.forEach(x => { const p = f(x); if (p && p.id && !out.has(p.id)) { out.set(p.id, p); } }); }
      } catch { /* galería ilegible */ }
    };
    read('mlImageGallery', x => ({ id: x.id || x.pictureId, url: x.thumbnailUrl || x.url || x.fullSizeUrl }));
    read('mlImageCatalog', x => ({ id: x.picture_id, url: x.thumbnail_url || x.full_url }));
    return Array.from(out.values());
  }

  inGallerySelection(p: Photo): boolean { return !!this.galleryRow?.pictures.some(x => x.id === p.id); }

  toggleGalleryPhoto(p: Photo): void {
    const row = this.galleryRow;
    if (!row || this.isLocked(row)) { return; }
    const i = row.pictures.findIndex(x => x.id === p.id);
    if (i >= 0) { row.pictures.splice(i, 1); }
    else if (row.pictures.length < this.maxPictures) { row.pictures.push({ ...p }); }
    else { row.photoError = `Máximo ${this.maxPictures} fotos para esta categoría.`; }
    this.onEdit(row);
  }

  closeGallery(): void { this.galleryRow = null; }

  // =====================================================
  // Títulos con IA (un solo botón)
  // =====================================================

  get unpublishedRows(): BulkRow[] { return this.rows.filter(r => r.status === 'pending' || r.status === 'error'); }
  get editedTargets(): BulkRow[] { return this.unpublishedRows.filter(r => r.titleEdited); }

  requestTitles(): void {
    if (this.titlesBusy || !this.rowsSourceId || this.unpublishedRows.length === 0) { return; }
    if (this.editedTargets.length > 0) { this.openModal('titles'); return; }
    this.runTitles(false);
  }

  async runTitles(overwrite: boolean): Promise<void> {
    this.closeModal();
    const targets = this.unpublishedRows.filter(r => overwrite || !r.titleEdited);
    if (targets.length === 0) { this.titlesMessage = { kind: 'warn', text: 'No hay filas sin editar para proponer títulos.' }; return; }
    const source = this.rowsSourceId || this.sourceId;
    this.titlesBusy = true;
    this.titlesMessage = null;
    try {
      const r: any = await firstValueFrom(this.http.post(`${environment.apiUrl}/opportunities/bulk-titles`, { itemId: source, count: targets.length }));
      const titles: Array<{ title: string; feature: string }> = Array.isArray(r.titles) ? r.titles : [];
      targets.forEach((row, i) => {
        const t = titles[i];
        row.familyName = t ? t.title : '';
        row.aiNote = t ? (t.feature || '') : '';
        row.titleEdited = false;
        row.validation = null;
      });
      const blank = targets.length - Math.min(titles.length, targets.length);
      const parts = [`Se propusieron ${Math.min(titles.length, targets.length)} título(s). Revísalos y edítalos: son propuestas, no se aplican solos.`];
      if (blank > 0) { parts.push(`${blank} fila(s) quedaron en blanco porque no hubo suficientes títulos válidos; escríbelos a mano.`); }
      if (Array.isArray(r.warnings) && r.warnings.length) { parts.push(r.warnings.join(' ')); }
      if (r.usage) { parts.push(`Usos de IA hoy: ${r.usage.used} de ${r.usage.limit}.`); }
      this.titlesMessage = { kind: blank > 0 ? 'warn' : 'ok', text: parts.join(' ') };
      this.changed();
    } catch (err) {
      const e = this.parseHttpError(err, 'No se pudieron proponer los títulos');
      const code = (err as HttpErrorResponse)?.error?.code;
      this.titlesMessage = {
        kind: 'error',
        text: code === 'AI_NOT_CONFIGURED'
          ? 'La IA no está configurada en el servidor. Escribe los títulos a mano; el resto de la página funciona igual.'
          : e.message
      };
    } finally {
      this.titlesBusy = false;
    }
  }

  // =====================================================
  // Validación local, avisos y payloads
  // =====================================================

  /** Problemas de la plantilla (iguales para todas las filas). */
  get templateIssues(): string[] {
    const t = this.tpl;
    if (!t) { return []; }
    const out: string[] = [];
    if (!t.categoryId) { out.push('El original no trae categoría.'); }
    const bad = (n: any) => n === null || n === undefined || isNaN(Number(n)) || Number(n) <= 0;
    if (bad(t.pkg.height) || bad(t.pkg.width) || bad(t.pkg.length) || bad(t.pkg.weight)) {
      out.push('Al original le faltan las medidas o el peso del paquete. Complétalos con "Duplicar" (formulario normal) o en el original.');
    }
    t.categoryAttributes.forEach(a => {
      if (!(a.tags.required || a.tags.catalog_required) || a.value_type === 'boolean') { return; }
      const empty = (v: any) => v === undefined || v === null || v === '';
      const missing = a.value_type === 'number_unit'
        ? empty(t.attributeValues[a.id + '_number']) || !t.attributeValues[a.id + '_unit']
        : empty(t.attributeValues[a.id]);
      const v = this.chosenVariation;
      if (missing && !(v && v.attributes.some(x => x.id === a.id))) { out.push(`Falta el atributo requerido "${a.name}" en el original.`); }
    });
    return out;
  }

  rowErrors(row: BulkRow): string[] {
    const out: string[] = [];
    const title = row.familyName.trim();
    if (!title) { out.push('Escribe el título.'); }
    else if (row.familyName.length > MAX_TITLE) { out.push(`El título pasa de ${MAX_TITLE} caracteres.`); }
    if (!(Number(row.price) > 0)) { out.push('El precio debe ser mayor que 0.'); }
    if (!Number.isInteger(Number(row.quantity)) || Number(row.quantity) < 1) { out.push('El stock debe ser un entero de al menos 1.'); }
    if (row.pictures.length < 1) { out.push('Agrega al menos una foto.'); }
    if (row.pictures.length > this.maxPictures) { out.push(`La categoría permite ${this.maxPictures} fotos.`); }
    return out;
  }

  private get allTitleWarnings(): string[][] {
    return titleWarnings(this.rows.map(r => r.familyName), this.tpl?.originalFamilyName || this.rowsSourceTitle);
  }

  warningsFor(row: BulkRow): string[] {
    const i = this.rows.indexOf(row);
    return i >= 0 ? this.allTitleWarnings[i] : [];
  }

  get anyTitleWarning(): boolean { return this.allTitleWarnings.some((w, i) => w.length > 0 && this.rows[i].status !== 'published'); }

  /** Payload de una fila: igual al del formulario de Publicar (una publicación por fila). */
  buildPayload(row: BulkRow): any {
    const t = this.tpl!;
    const v = this.chosenVariation;
    let attributes = this.tplSvc.buildAttributes({
      pkg: t.pkg, weightInGrams: this.tplSvc.weightInGrams(t.pkg), categoryAttributes: t.categoryAttributes,
      attributeValues: t.attributeValues, gtin: t.gtin, gtinReasons: t.gtinReasons,
      emptyGtinReason: t.emptyGtinReason, extraAttributes: t.extraAttributes
    });
    if (v) { attributes = this.tplSvc.mergeVariationAttributes(attributes, v.attributes); }
    return {
      family_name: row.familyName.trim(),
      category_id: t.categoryId,
      price: Number(row.price),
      currency_id: 'MXN',
      available_quantity: Number(row.quantity),
      buying_mode: 'buy_it_now',
      condition: row.condition,
      listing_type_id: t.listingTypeId,
      sale_terms: this.tplSvc.buildSaleTerms(t.warrantyType, t.warrantyTime, t.otherSaleTerms),
      shipping: { mode: 'me2', local_pick_up: t.localPickUp, free_shipping: t.freeShipping },
      description: t.description,
      attributes,
      pictures: row.pictures.map(p => ({ id: p.id })),
    };
  }

  // =====================================================
  // Validar todas (POST /items/validate, concurrencia 2; no publica)
  // =====================================================

  get validatableRows(): BulkRow[] { return this.rows.filter(r => r.status === 'pending' || r.status === 'error'); }
  get canValidate(): boolean { return !!this.tpl && this.templateIssues.length === 0 && !this.validatingAll && !this.publishing && this.validatableRows.length > 0; }

  async validateAll(): Promise<void> {
    if (!this.canValidate) { return; }
    this.validatingAll = true;
    const list = this.validatableRows;
    list.forEach(r => { r.validation = null; });
    await runPool(list, VALIDATE_CONCURRENCY, async row => {
      const local = this.rowErrors(row);
      if (local.length) { row.validation = { ok: false, errors: local.map(m => ({ code: 'local', message: m })), warnings: [] }; return; }
      row.validating = true;
      try {
        const res: any = await firstValueFrom(this.http.post(`${environment.apiUrl}/items/validate`, this.buildPayload(row)));
        const s = splitIssues<ErrorCause>(res.errors || [], res.warnings || []);
        row.validation = { ok: s.errors.length === 0, errors: s.errors, warnings: s.warnings };
      } catch (err) {
        const e = this.parseHttpError(err, 'No se pudo validar');
        row.validation = { ok: false, errors: e.causes.length ? e.causes : [{ code: 'validate', message: e.message }], warnings: [], failed: e.message };
      } finally {
        row.validating = false;
      }
    });
    this.validatingAll = false;
  }

  get validCount(): number { return this.rows.filter(r => r.validation?.ok).length; }

  // =====================================================
  // Publicar (de una en una desde el navegador)
  // =====================================================

  /** Filas que se enviarían: pendientes o con error de ML (las "sin confirmar" nunca se reenvían solas). */
  get publishable(): BulkRow[] { return this.rows.filter(r => r.status === 'pending' || r.status === 'error'); }
  get publishableValid(): BulkRow[] { return this.publishable.filter(r => this.rowErrors(r).length === 0); }
  get canPublish(): boolean { return !!this.tpl && this.templateIssues.length === 0 && !this.publishing && !this.validatingAll && this.publishableValid.length > 0; }

  requestPublish(): void { if (this.canPublish) { this.openModal('publish'); } }

  stop(): void { this.stopRequested = true; }

  async confirmPublish(): Promise<void> {
    if (!this.canPublish) { return; }
    this.closeModal();
    const queue = [...this.publishableValid];
    this.publishing = true;
    this.stopRequested = false;
    this.banner = null;
    let first = true;
    try {
      for (const row of queue) {
        if (this.stopRequested || this.destroyed) { break; }
        if (!first) {
          await sleep(PUBLISH_GAP_MS);
          if (this.stopRequested || this.destroyed) { break; }
        }
        first = false;
        await this.publishOne(row);
      }
    } finally {
      this.publishing = false;
      this.caching.invalidatePattern(/\/items/i);
      this.saveNow();
    }
    const done = queue.filter(r => r.status === 'published').length;
    const pending = queue.filter(r => r.status === 'pending' || r.status === 'publishing').length;
    if (this.stopRequested && pending > 0) {
      this.banner = { kind: 'warn', text: `Envío detenido: ${done} publicada(s), ${pending} pendiente(s) sin enviar.` };
    } else if (queue.some(r => r.status === 'unconfirmed')) {
      this.banner = { kind: 'warn', text: 'Alguna fila quedó "sin confirmar": verifica en Publicaciones si Mercado Libre la creó antes de reintentar.' };
    }
    this.stopRequested = false;
  }

  private async publishOne(row: BulkRow): Promise<void> {
    row.status = 'publishing';
    row.validation = null;
    row.error = undefined;
    row.causes = [];
    this.saveNow();   // si se recarga a mitad del envío, esta fila reaparece "sin confirmar", nunca "pendiente"
    const payload = this.buildPayload(row);
    try {
      const r: any = await firstValueFrom(this.http.post(`${environment.apiUrl}/items`, payload));
      row.status = 'published';
      row.itemId = r.item?.id;
      row.permalink = r.item?.permalink;
      const text = String(payload.description || '');
      if (!text.trim()) { row.descriptionState = 'none'; }
      else if (r.description?.ok === false) { row.descriptionState = 'failed'; row.descriptionError = r.description.error; row.descriptionText = text; }
      else { row.descriptionState = 'ok'; }
    } catch (err) {
      const e = this.parseHttpError(err, 'Error al publicar');
      row.error = e.message;
      row.causes = e.causes;
      // Sin respuesta (red) o 5xx: ML pudo haberla creado. Nunca se reintenta sola.
      if (e.status === 0 || e.status >= 500) {
        row.status = 'unconfirmed';
        row.error = 'No se pudo confirmar si Mercado Libre la creó. Verifica en Publicaciones antes de reintentar.';
      } else {
        row.status = 'error';
      }
    }
    this.saveNow();
  }

  /** El usuario revisó Publicaciones y la fila no existe: vuelve a poder enviarse. */
  confirmNotCreated(row: BulkRow): void {
    if (row.status !== 'unconfirmed') { return; }
    row.status = 'error';
    row.error = 'Marcada como no creada por ti. Puedes volver a publicarla.';
    this.changed();
  }

  /** Reintenta solo el paso "descripción" de una fila ya creada. */
  async retryDescription(row: BulkRow): Promise<void> {
    if (!row.itemId || row.descriptionState === 'retrying' || !row.descriptionText) { return; }
    row.descriptionState = 'retrying';
    try {
      await firstValueFrom(this.http.post(`${environment.apiUrl}/items/${encodeURIComponent(row.itemId)}/description`, { plain_text: row.descriptionText }));
      row.descriptionState = 'ok';
      row.descriptionError = undefined;
      row.descriptionText = undefined;
    } catch (err) {
      row.descriptionState = 'failed';
      row.descriptionError = this.parseHttpError(err, 'No se pudo guardar la descripción').message;
    }
    this.saveNow();
  }

  get counts(): { pending: number; published: number; error: number; unconfirmed: number } {
    const c = { pending: 0, published: 0, error: 0, unconfirmed: 0 };
    this.rows.forEach(r => {
      if (r.status === 'published') { c.published++; }
      else if (r.status === 'error') { c.error++; }
      else if (r.status === 'unconfirmed') { c.unconfirmed++; }
      else { c.pending++; }
    });
    return c;
  }

  statusLabel(s: RowStatus): string {
    return { pending: 'Pendiente', publishing: 'Publicando…', published: 'Publicada', error: 'Error', unconfirmed: 'Sin confirmar' }[s];
  }
  statusTone(s: RowStatus): string {
    return { pending: '', publishing: 'tone-info', published: 'tone-success', error: 'tone-error', unconfirmed: 'tone-warning' }[s];
  }

  // =====================================================
  // Modales
  // =====================================================

  openModal(k: ModalKind): void { this.modal = k; this.openModalFocus(); }
  closeModal(): void { this.modal = null; }
  private openModalFocus(): void { setTimeout(() => this.modalEl?.nativeElement.focus(), 0); }

  requestDiscard(): void { this.openModal('discard'); }

  discard(): void {
    this.closeModal();
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    if (this.draftKey) { try { localStorage.removeItem(this.draftKey); } catch { /* ignore */ } }
    this.rows = [];
    this.tpl = null;
    this.rowsSourceId = ''; this.rowsSourceTitle = ''; this.rowsVariationKey = null;
    this.draftRestored = false;
    this.banner = null;
    this.titlesMessage = null;
    this.nextKey = 1;
  }

  goPublications(): void { this.router.navigate(['/publications']); }

  // =====================================================
  // Borrador (localStorage, por cuenta)
  // =====================================================

  changed(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); }
    this.saveTimer = setTimeout(() => this.saveNow(), 400);
  }

  saveNow(): void {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    const key = this.draftKey;
    if (!key) { return; }
    if (this.rows.length === 0) { try { localStorage.removeItem(key); } catch { /* ignore */ } return; }
    const draft = {
      v: DRAFT_VERSION, savedAt: Date.now(), uid: this.uid, sourceId: this.rowsSourceId, sourceTitle: this.rowsSourceTitle,
      copies: this.copies, variationKey: this.rowsVariationKey, nextKey: this.nextKey,
      rows: this.rows.map(r => ({
        key: r.key, familyName: r.familyName, titleEdited: r.titleEdited, aiNote: r.aiNote, price: r.price, quantity: r.quantity,
        condition: r.condition, pictures: r.pictures, status: r.status, itemId: r.itemId, permalink: r.permalink, error: r.error,
        causes: r.causes, descriptionState: r.descriptionState === 'retrying' ? 'failed' : r.descriptionState,
        descriptionError: r.descriptionError, descriptionText: r.descriptionText
      }))
    };
    try { localStorage.setItem(key, JSON.stringify(draft)); } catch { /* cuota llena: se ignora */ }
  }

  private restoreDraft(): boolean {
    const key = this.draftKey;
    if (!key) { return false; }
    let raw: string | null = null;
    try { raw = localStorage.getItem(key); } catch { return false; }
    if (!raw) { return false; }
    try {
      const d = JSON.parse(raw);
      if (!d || d.v !== DRAFT_VERSION || d.uid !== this.uid || !Array.isArray(d.rows) || d.rows.length === 0) { return false; }
      this.rowsSourceId = String(d.sourceId || '');
      this.rowsSourceTitle = String(d.sourceTitle || '');
      this.sourceId = this.rowsSourceId;
      this.sourceTitle = this.rowsSourceTitle;
      this.query = this.sourceTitle;
      this.copies = clampCopies(d.copies);
      this.rowsVariationKey = d.variationKey ?? null;
      this.nextKey = Number(d.nextKey) || d.rows.length + 1;
      this.rows = d.rows.slice(0, MAX_COPIES).map((r: any): BulkRow => ({
        key: r.key, familyName: String(r.familyName ?? ''), titleEdited: !!r.titleEdited, aiNote: String(r.aiNote ?? ''),
        price: r.price ?? null, quantity: r.quantity ?? null, condition: r.condition === 'used' ? 'used' : 'new',
        pictures: Array.isArray(r.pictures) ? r.pictures.filter((p: any) => p && p.id) : [],
        // Una fila que estaba enviándose cuando se cerró la página puede haberse creado: queda "sin confirmar".
        status: r.status === 'publishing' ? 'unconfirmed' : (['pending', 'published', 'error', 'unconfirmed'].includes(r.status) ? r.status : 'pending'),
        itemId: r.itemId, permalink: r.permalink,
        error: r.status === 'publishing' ? 'La página se cerró mientras se enviaba. Verifica en Publicaciones antes de reintentar.' : r.error,
        causes: Array.isArray(r.causes) ? r.causes : [], descriptionState: r.descriptionState || 'none',
        descriptionError: r.descriptionError, descriptionText: r.descriptionText
      }));
      this.draftRestored = true;
      return true;
    } catch {
      return false;
    }
  }

  // =====================================================
  // Utilidades
  // =====================================================

  private parseHttpError(err: unknown, fallback: string): { message: string; status: number; causes: ErrorCause[] } {
    if (err instanceof HttpErrorResponse) {
      const body: any = err.error;
      const causes: ErrorCause[] = Array.isArray(body?.causes) ? body.causes : [];
      const message = err.status === 0 ? 'No hay conexión con el servidor' : (body?.error || body?.message || fallback);
      return { message: String(message), status: err.status, causes };
    }
    return { message: (err as any)?.message || fallback, status: 0, causes: [] };
  }

  trackByKey(_: number, r: BulkRow): number { return r.key; }
  trackByIndex(i: number): number { return i; }

  get hasPendingWork(): boolean { return this.rows.length > 0; }
  get tplVariationNote(): string {
    const n = this.usableVariations.length;
    return n > 0 ? `Este original tiene ${n} variaciones. Cada fila copia la variación elegida (su precio, stock, fotos y atributos) y se publica como una publicación independiente.` : '';
  }
  get publishTotals(): { rows: number } { return { rows: this.publishableValid.length }; }
}
