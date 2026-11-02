import { Component, OnDestroy, OnInit } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom, Subject, Subscription } from 'rxjs';
import { debounceTime, distinctUntilChanged } from 'rxjs/operators';
import { ActivatedRoute, Router } from '@angular/router';
import { environment } from '../../environments/environment';
import { CategoryPredictorService, CategoryPrediction, CategoryAttribute } from '../services/category-predictor.service';
import { CachingService } from '../services/caching.service';
import { satRetention } from '../shared/order-math';

/** Causa de error devuelta por el backend (preserva el código de ML). */
export interface ErrorCause { code: string; message: string; type?: string; }

export interface ListingFee {
  listing_type_id: string;
  listing_type_name: string;
  sale_fee_amount: number;
  percentage_fee: number | null;
  fixed_fee: number;
}

interface VariationDraft {
  key: number;
  include: boolean;
  label: string;
  price: number;
  quantity: number;
  pictureIds: string[];
  attributes: Array<{ id: string; value_id?: string; value_name: string }>;
  unresolved: boolean;      // algún atributo de la combinación no trae ID usable
}

type JobStatus = 'pending' | 'creating' | 'created' | 'failed' | 'unknown';

interface PublishJob {
  label: string;
  payload: any;
  status: JobStatus;
  itemId?: string;
  permalink?: string;
  error?: string;
  causes: ErrorCause[];
  description: string;
  descriptionState: 'none' | 'ok' | 'failed' | 'retrying';
  descriptionError?: string;
}

interface PackageForm {
  height: number | null;
  width: number | null;
  length: number | null;
  weight: number | null;
  weightUnit: 'g' | 'kg';
}

const DRAFT_PREFIX = 'publish-draft:';
const FALLBACK_MAX_PICTURES = 12;
const WARRANTY_TYPES = ['Garantía del vendedor', 'Garantía de fábrica', 'Sin garantía'];
const PACKAGE_IDS = ['SELLER_PACKAGE_HEIGHT', 'SELLER_PACKAGE_WIDTH', 'SELLER_PACKAGE_LENGTH', 'SELLER_PACKAGE_WEIGHT'];
const EMPTY_GTIN_DEFAULT_REASON = '17055160'; // "El producto no tiene código registrado" (MLM)

@Component({
  selector: 'app-publish-product',
  templateUrl: './publish-product.component.html',
  styleUrls: ['./publish-product.component.scss']
})
export class PublishProductComponent implements OnInit, OnDestroy {
  readonly warrantyTypes = WARRANTY_TYPES;

  // ---- Modo ----
  isDuplicateMode = false;
  sourceId = '';
  isLoadingSource = false;
  sourceError = '';
  sourceStatus = '';
  draftRestored = false;
  private draftKey = DRAFT_PREFIX + 'create';
  private saveTimer: any = null;
  private suppressDraft = false;

  // ---- Producto ----
  familyName = '';
  originalFamilyName = '';
  categoryId = '';
  categoryName = '';
  categoryPath = '';
  price: number | null = null;
  quantity: number | null = 1;
  condition = 'new';
  listingTypeId: 'gold_special' | 'gold_pro' = 'gold_special';
  listingTypeNote = '';
  description = '';
  freeShipping = false;
  localPickUp = false;
  fulfillmentNote = '';
  warrantyType = 'Garantía del vendedor';
  warrantyTime = '90 días';
  otherSaleTerms: Array<{ id: string; value_id?: string; value_name?: string }> = [];
  package: PackageForm = { height: null, width: null, length: null, weight: null, weightUnit: 'g' };

  // ---- Atributos ----
  allCategoryAttributes: CategoryAttribute[] = [];
  categoryAttributes: CategoryAttribute[] = [];
  isLoadingAttributes = false;
  attributeValues: { [key: string]: any } = {};
  attributeErrors: { [key: string]: string } = {};
  extraAttributes: Array<{ id: string; value_id?: string; value_name?: string }> = []; // ocultos copiados del original
  gtin = '';
  emptyGtinReason = EMPTY_GTIN_DEFAULT_REASON;
  gtinReasons: Array<{ id: string; name: string }> = [];
  hasGtinAttr = false;
  skuCleared = false;

  // ---- Variaciones (cada una se publica como publicación aparte: User Products) ----
  variations: VariationDraft[] = [];

  // ---- Fotos ----
  maxPictures = FALLBACK_MAX_PICTURES;
  pictureWarning = '';
  originalItemImages: any[] = [];
  duplicatePictureIds: string[] = [];
  validatedPictureIds: Array<{ id: string; url?: string }> = [];
  picturesText = '';
  selectorReady = false;
  pictureThumbs: { [id: string]: string } = {};

  // ---- Categoría (modo crear) ----
  categoryPredictions: CategoryPrediction[] = [];
  isLoadingPredictions = false;
  showCategoryPredictions = false;
  private productNameSubject = new Subject<string>();

  // ---- Comisiones ----
  fees: ListingFee[] = [];
  feesError = '';
  isLoadingFees = false;
  private feeSubject = new Subject<void>();

  // ---- Envío de datos ----
  jobs: PublishJob[] = [];
  submitting = false;
  validating = false;
  validationResult: { valid: boolean; errors: ErrorCause[]; warnings: ErrorCause[] } | null = null;
  formErrors: ErrorCause[] = [];       // errores de ML o de validación local, arriba del formulario
  formErrorTitle = '';
  showResult = false;

  private subs = new Subscription();

  constructor(
    private http: HttpClient,
    private router: Router,
    private route: ActivatedRoute,
    private categoryPredictor: CategoryPredictorService,
    private cachingService: CachingService
  ) { }

  // =====================================================
  // Ciclo de vida
  // =====================================================

  ngOnInit(): void {
    this.subs.add(this.productNameSubject.pipe(debounceTime(800), distinctUntilChanged()).subscribe(name => {
      if (name && name.trim().length >= 3 && !this.isDuplicateMode) {
        this.predictCategory(name);
      } else {
        this.categoryPredictions = [];
        this.showCategoryPredictions = false;
      }
    }));

    this.subs.add(this.feeSubject.pipe(debounceTime(500)).subscribe(() => this.loadFees()));

    this.subs.add(this.route.queryParams.subscribe(params => {
      const from = params['from'] as string | undefined;
      if (params['mode'] === 'duplicate' && from && /^MLM\d+$/.test(from)) {
        this.isDuplicateMode = true;
        this.sourceId = from;
        this.draftKey = DRAFT_PREFIX + 'duplicate:' + from;
        this.loadDuplicateData(from);
      } else if (params['mode'] === 'duplicate') {
        this.isDuplicateMode = true;
        this.sourceError = 'No se indicó qué publicación duplicar. Vuelve a Publicaciones y usa el botón Duplicar.';
      } else {
        this.isDuplicateMode = false;
        this.draftKey = DRAFT_PREFIX + 'create';
        this.selectorReady = true;
        this.restoreDraft();
      }
    }));
  }

  ngOnDestroy(): void {
    this.subs.unsubscribe();
    if (this.saveTimer) { clearTimeout(this.saveTimer); }
  }

  // =====================================================
  // Modo duplicar: siempre se pide el item fresco a ML
  // =====================================================

  async loadDuplicateData(id: string): Promise<void> {
    this.isLoadingSource = true;
    this.sourceError = '';
    this.suppressDraft = true;
    try {
      const item: any = await firstValueFrom(this.http.get<any>(`${environment.apiUrl}/items/${encodeURIComponent(id)}`));
      this.sourceStatus = item.status || '';

      let description = '';
      try {
        const d: any = await firstValueFrom(this.http.get<any>(`${environment.apiUrl}/items/${encodeURIComponent(id)}/description`));
        description = d?.plain_text || '';
      } catch { description = ''; }

      this.originalFamilyName = (item.family_name || item.title || '').toString();
      this.familyName = this.originalFamilyName.slice(0, 60);
      this.categoryId = item.category_id;
      this.price = item.price;
      this.quantity = item.available_quantity > 0 ? item.available_quantity : 1;
      this.condition = item.condition === 'used' ? 'used' : 'new';
      this.description = description;

      if (item.listing_type_id === 'gold_pro') {
        this.listingTypeId = 'gold_pro';
      } else {
        this.listingTypeId = 'gold_special';
        if (item.listing_type_id !== 'gold_special') {
          this.listingTypeNote = `El original usa "${item.listing_type_id}", que ya no se ofrece: se eligió Clásica.`;
        }
      }

      this.freeShipping = !!item.shipping?.free_shipping;
      this.localPickUp = !!item.shipping?.local_pick_up;
      if (item.shipping?.logistic_type === 'fulfillment') {
        this.fulfillmentNote = 'El original se envía con Full. La copia se publica con envío del vendedor (Full no se copia) y el stock lo defines tú.';
      }

      // Garantía y otros términos de venta (por id, no por posición)
      const terms: any[] = Array.isArray(item.sale_terms) ? item.sale_terms : [];
      const wType = terms.find(t => t.id === 'WARRANTY_TYPE');
      const wTime = terms.find(t => t.id === 'WARRANTY_TIME');
      this.warrantyType = wType?.value_name && WARRANTY_TYPES.includes(wType.value_name) ? wType.value_name : (wType ? 'Sin garantía' : 'Sin garantía');
      this.warrantyTime = wTime?.value_name || '';
      this.otherSaleTerms = terms
        .filter(t => t.id !== 'WARRANTY_TYPE' && t.id !== 'WARRANTY_TIME')
        .map(t => t.value_id ? { id: t.id, value_id: t.value_id } : { id: t.id, value_name: t.value_name });

      // Fotos: se copian por id (ya alojadas en ML), hasta el máximo de la categoría
      const pics: any[] = Array.isArray(item.pictures) ? item.pictures : [];
      pics.forEach(p => { this.pictureThumbs[p.id] = p.secure_url || p.url; });
      this.originalItemImages = pics;

      // Atributos del original
      this.hydrateFromItemAttributes(item.attributes || []);

      // Variaciones legacy -> publicaciones separadas
      this.variations = (item.variations || []).map((v: any, i: number) => this.mapVariation(v, i));
      (item.variations || []).forEach((v: any) => (v.picture_ids || []).forEach((pid: string) => {
        const pic = pics.find(p => p.id === pid);
        if (pic) { this.pictureThumbs[pid] = pic.secure_url || pic.url; }
      }));
      if (this.variations.length > 0) {
        this.quantity = this.variations.reduce((s, v) => s + (v.include ? v.quantity : 0), 0) || 1;
      }

      await this.loadCategoryContext(this.categoryId);
      this.applyPictureLimit(pics.map(p => p.id));
      this.selectorReady = true;
      this.restoreDraft();
      this.queueFees();
    } catch (err) {
      const e = this.parseHttpError(err, 'No se pudo cargar la publicación a duplicar');
      this.sourceError = e.message;
    } finally {
      this.isLoadingSource = false;
      this.suppressDraft = false;
    }
  }

  private mapVariation(v: any, i: number): VariationDraft {
    let unresolved = false;
    const attrs = (v.attribute_combinations || []).map((a: any) => {
      let id: string | null = a.id || null;
      if (!id && typeof a.name === 'string' && /^[A-Z][A-Z0-9_]+$/.test(a.name)) { id = a.name; }
      if (!id) { unresolved = true; return null; }
      return a.value_id ? { id, value_id: String(a.value_id), value_name: a.value_name } : { id, value_name: a.value_name };
    }).filter(Boolean);
    const label = (v.attribute_combinations || []).map((a: any) => `${a.name}: ${a.value_name}`).join(' · ') || `Variación ${i + 1}`;
    return {
      key: v.id ?? i, include: !unresolved, label, price: v.price, quantity: v.available_quantity || 0,
      pictureIds: v.picture_ids || [], attributes: attrs, unresolved
    };
  }

  /** Copia todos los atributos del original que el formulario sabe mostrar o que deben conservarse. */
  private hydrateFromItemAttributes(attrs: any[]): void {
    this.extraAttributes = [];
    this.attributeValues = {};
    this.gtin = '';
    this.skuCleared = false;
    const pkg = this.package;
    attrs.forEach((a: any) => {
      let id: string | null = a.id || null;
      if (!id && typeof a.name === 'string' && /^[A-Z][A-Z0-9_]+$/.test(a.name)) { id = a.name; }
      if (!id) { return; }
      const struct = a.value_struct || a.values?.[0]?.struct || null;
      if (PACKAGE_IDS.includes(id)) {
        const n = struct?.number ?? parseFloat(String(a.value_name));
        if (id === 'SELLER_PACKAGE_HEIGHT') { pkg.height = n; }
        if (id === 'SELLER_PACKAGE_WIDTH') { pkg.width = n; }
        if (id === 'SELLER_PACKAGE_LENGTH') { pkg.length = n; }
        if (id === 'SELLER_PACKAGE_WEIGHT') {
          const unit = (struct?.unit || (String(a.value_name).includes('kg') ? 'kg' : 'g')) as string;
          pkg.weightUnit = unit === 'kg' ? 'kg' : 'g';
          pkg.weight = n;
          if (unit !== 'kg' && unit !== 'g') { pkg.weightUnit = 'g'; }
        }
        return;
      }
      if (id === 'SELLER_SKU') { this.skuCleared = true; return; }     // debe ser único: no se copia
      if (id === 'GTIN') { if (a.value_id !== '-1' && a.value_name) { this.gtin = String(a.value_name); } return; }
      if (id === 'EMPTY_GTIN_REASON') { if (a.value_id) { this.emptyGtinReason = String(a.value_id); } return; }
      if (a.value_id === '-1' || (!a.value_id && !a.value_name)) { return; }
      this.attributeValues['__raw_' + id] = { id, value_id: a.value_id || undefined, value_name: a.value_name, struct };
    });
  }

  /** Una vez cargados los atributos de la categoría, mapea los valores crudos del original a los controles. */
  private applyRawAttributeValues(): void {
    const rawKeys = Object.keys(this.attributeValues).filter(k => k.startsWith('__raw_'));
    const displayed = new Map(this.categoryAttributes.map(a => [a.id, a] as const));
    const all = new Map(this.allCategoryAttributes.map(a => [a.id, a] as const));
    rawKeys.forEach(k => {
      const raw = this.attributeValues[k];
      delete this.attributeValues[k];
      const def = displayed.get(raw.id);
      if (!def) {
        const full = all.get(raw.id);
        // Atributos ocultos pero no de solo lectura se conservan tal cual
        if (full && !full.tags.read_only) {
          this.extraAttributes.push(raw.value_id ? { id: raw.id, value_id: raw.value_id } : { id: raw.id, value_name: raw.value_name });
        }
        return;
      }
      switch (def.value_type) {
        case 'list': {
          let opt = raw.value_id ? def.values?.find(v => v.id === raw.value_id) : undefined;
          if (!opt) { opt = def.values?.find(v => v.name?.toLowerCase() === String(raw.value_name).toLowerCase()); }
          if (opt) { this.attributeValues[def.id] = opt.id; }
          else if (raw.value_name) { this.extraAttributes.push({ id: raw.id, value_name: raw.value_name }); }
          break;
        }
        case 'number_unit': {
          const n = raw.struct?.number ?? parseFloat(String(raw.value_name));
          const unit = raw.struct?.unit || String(raw.value_name).split(' ')[1] || def.default_unit || def.allowed_units?.[0]?.id;
          this.attributeValues[def.id + '_number'] = n;
          this.attributeValues[def.id + '_unit'] = unit;
          break;
        }
        case 'number':
          this.attributeValues[def.id] = raw.struct?.number ?? parseFloat(String(raw.value_name));
          break;
        case 'boolean': {
          const opt = def.values?.find(v => v.id === raw.value_id);
          this.attributeValues[def.id] = opt ? opt.name === 'Sí' : String(raw.value_name).toLowerCase().startsWith('s');
          break;
        }
        default:
          this.attributeValues[def.id] = raw.value_name;
      }
    });
  }

  // =====================================================
  // Categoría: atributos, límites y comisiones
  // =====================================================

  private async loadCategoryContext(categoryId: string): Promise<void> {
    this.isLoadingAttributes = true;
    try {
      const [cat, attrs] = await Promise.all([
        firstValueFrom(this.categoryPredictor.getCategoryDetails(categoryId)).catch(() => null),
        firstValueFrom(this.categoryPredictor.getCategoryAttributes(categoryId))
      ]);
      if (cat) {
        this.categoryName = cat.name || this.categoryName;
        this.categoryPath = (cat.path_from_root || []).map((p: any) => p.name).join(' › ');
        this.maxPictures = cat.settings?.max_pictures_per_item || FALLBACK_MAX_PICTURES;
      }
      this.allCategoryAttributes = attrs;
      this.hasGtinAttr = attrs.some(a => a.id === 'GTIN');
      const reason = attrs.find(a => a.id === 'EMPTY_GTIN_REASON');
      this.gtinReasons = (reason?.values || []).map(v => ({ id: v.id, name: v.name }));
      this.categoryAttributes = attrs
        .filter(a => {
          if (a.id === 'GTIN' || a.id === 'EMPTY_GTIN_REASON' || a.id.startsWith('SELLER_PACKAGE_') || a.id === 'ITEM_CONDITION') { return false; }
          const required = a.tags.required || a.tags.catalog_required;
          return required || (!a.tags.hidden && !a.tags.read_only);
        })
        .sort((a, b) => {
          const ar = a.tags.required || a.tags.catalog_required;
          const br = b.tags.required || b.tags.catalog_required;
          if (ar && !br) { return -1; }
          if (!ar && br) { return 1; }
          return b.relevance - a.relevance;
        });
      this.applyRawAttributeValues();
    } catch (err) {
      this.formErrorTitle = 'No se pudieron cargar los atributos de la categoría';
      this.formErrors = [{ code: 'attributes_load', message: this.parseHttpError(err, 'Error al cargar atributos').message }];
    } finally {
      this.isLoadingAttributes = false;
    }
  }

  private applyPictureLimit(ids: string[]): void {
    this.pictureWarning = '';
    if (ids.length > this.maxPictures) {
      this.pictureWarning = `La categoría permite ${this.maxPictures} fotos y el original tiene ${ids.length}: se copiaron las primeras ${this.maxPictures}.`;
    }
    this.duplicatePictureIds = ids.slice(0, this.maxPictures);
    this.originalItemImages = this.originalItemImages.slice(0, this.maxPictures);
  }

  queueFees(): void { this.feeSubject.next(); }

  private loadFees(): void {
    if (!this.price || this.price <= 0 || !/^MLM\d+$/.test(this.categoryId)) { this.fees = []; return; }
    this.isLoadingFees = true;
    this.feesError = '';
    this.http.get<ListingFee[]>(`${environment.apiUrl}/items/listing-prices`, {
      params: { price: String(this.price), category_id: this.categoryId }
    }).subscribe({
      next: list => { this.fees = list; this.isLoadingFees = false; },
      error: err => {
        this.isLoadingFees = false;
        this.fees = [];
        this.feesError = this.parseHttpError(err, 'No se pudo calcular la comisión').message;
      }
    });
  }

  feeFor(typeId: string): ListingFee | undefined { return this.fees.find(f => f.listing_type_id === typeId); }

  get selectedFee(): ListingFee | undefined { return this.feeFor(this.listingTypeId); }

  get sat(): number { return this.price && this.price > 0 ? satRetention(this.price) : 0; }

  /** Recibes aprox. = precio − comisión − retención SAT (el envío lo paga el comprador salvo envío gratis). */
  get netAmount(): number | null {
    if (!this.price || this.price <= 0 || !this.selectedFee) { return null; }
    return this.price - this.selectedFee.sale_fee_amount - this.sat;
  }

  get publishCount(): number {
    return this.variations.length > 0 ? this.variations.filter(v => v.include && !v.unresolved).length : 1;
  }

  // =====================================================
  // Crear: predictor de categoría
  // =====================================================

  onProductNameChange(value: string): void { this.productNameSubject.next(value); }

  private predictCategory(name: string): void {
    this.isLoadingPredictions = true;
    this.categoryPredictor.predictCategory(name, 3).subscribe({
      next: r => {
        this.categoryPredictions = r.predictions;
        this.showCategoryPredictions = r.predictions.length > 0;
        this.isLoadingPredictions = false;
      },
      error: () => {
        this.categoryPredictions = [];
        this.showCategoryPredictions = false;
        this.isLoadingPredictions = false;
      }
    });
  }

  async selectPredictedCategory(p: CategoryPrediction): Promise<void> {
    this.categoryId = p.category_id;
    this.categoryName = p.category_name;
    this.showCategoryPredictions = false;
    this.attributeValues = {};
    await this.loadCategoryContext(p.category_id);
    this.queueFees();
    this.scheduleSave();
  }

  clearCategory(): void {
    this.categoryId = '';
    this.categoryName = '';
    this.categoryPath = '';
    this.categoryAttributes = [];
    this.allCategoryAttributes = [];
    this.fees = [];
    this.scheduleSave();
  }

  closeCategoryPredictions(): void { this.showCategoryPredictions = false; }

  // =====================================================
  // Fotos
  // =====================================================

  handleImagesValidated(ids: Array<{ id: string; url?: string }>): void {
    this.validatedPictureIds = ids;
  }

  thumb(id: string): string { return this.pictureThumbs[id] || ''; }

  // =====================================================
  // Validación local y construcción del payload
  // =====================================================

  /** Convierte el peso a gramos enteros según la unidad elegida. */
  get weightInGrams(): number | null {
    const w = Number(this.package.weight);
    if (!w || w <= 0) { return null; }
    return Math.max(1, Math.round(this.package.weightUnit === 'kg' ? w * 1000 : w));
  }

  private localValidate(): boolean {
    const errs: { [k: string]: string } = {};
    const bad = (v: any) => v === null || v === undefined || v === '' || isNaN(Number(v)) || Number(v) <= 0;
    if (!this.familyName.trim()) { errs['family_name'] = 'Escribe el nombre del producto'; }
    if (!this.categoryId) { errs['category'] = 'Elige una categoría'; }
    if (bad(this.price)) { errs['price'] = 'Ingresa un precio mayor que 0'; }
    if (this.variations.length === 0 && (bad(this.quantity) || Number(this.quantity) < 1)) { errs['quantity'] = 'La cantidad debe ser al menos 1'; }
    if (bad(this.package.height)) { errs['height'] = 'Requerido'; }
    if (bad(this.package.width)) { errs['width'] = 'Requerido'; }
    if (bad(this.package.length)) { errs['length'] = 'Requerido'; }
    if (bad(this.package.weight)) { errs['weight'] = 'Requerido'; }
    else if (this.weightInGrams !== null && this.weightInGrams > 100000000) { errs['weight'] = 'Peso demasiado grande'; }

    this.categoryAttributes.forEach(a => {
      const required = a.tags.required || a.tags.catalog_required;
      if (!required) { return; }
      if (a.value_type === 'number_unit') {
        const n = this.attributeValues[a.id + '_number'];
        const u = this.attributeValues[a.id + '_unit'];
        if (n === undefined || n === null || n === '' || !u) { errs[a.id] = 'Este campo es requerido'; }
      } else if (a.value_type === 'boolean') {
        // un boolean requerido siempre tiene valor (false = No)
      } else {
        const v = this.attributeValues[a.id];
        if (v === undefined || v === null || v === '') { errs[a.id] = 'Este campo es requerido'; }
      }
    });

    this.attributeErrors = errs;
    return Object.keys(errs).length === 0;
  }

  get hasLocalErrors(): boolean { return Object.keys(this.attributeErrors).length > 0; }

  private buildAttributes(): any[] {
    const out: any[] = [];
    const pkg = this.package;
    const int = (n: any) => Math.max(1, Math.round(Number(n)));
    out.push({ id: 'SELLER_PACKAGE_HEIGHT', value_name: `${int(pkg.height)} cm` });
    out.push({ id: 'SELLER_PACKAGE_WIDTH', value_name: `${int(pkg.width)} cm` });
    out.push({ id: 'SELLER_PACKAGE_LENGTH', value_name: `${int(pkg.length)} cm` });
    out.push({ id: 'SELLER_PACKAGE_WEIGHT', value_name: `${this.weightInGrams} g` });

    this.categoryAttributes.forEach(a => {
      const v = this.attributeValues[a.id];
      switch (a.value_type) {
        case 'string':
        case 'number':
          if (v !== undefined && v !== null && v !== '') { out.push({ id: a.id, value_name: String(v) }); }
          break;
        case 'list': {
          if (!v) { break; }
          const opt = a.values?.find(x => x.id === v);
          if (opt) { out.push({ id: a.id, value_id: opt.id, value_name: opt.name }); }
          break;
        }
        case 'number_unit': {
          const n = this.attributeValues[a.id + '_number'];
          const u = this.attributeValues[a.id + '_unit'];
          if (n !== undefined && n !== null && n !== '' && u) { out.push({ id: a.id, value_name: `${n} ${u}` }); }
          break;
        }
        case 'boolean': {
          if (v === undefined || v === null) { break; }
          const want = v ? 'Sí' : 'No';
          const opt = a.values?.find(x => x.name === want);
          out.push(opt ? { id: a.id, value_id: opt.id, value_name: opt.name } : { id: a.id, value_name: want });
          break;
        }
      }
    });

    // GTIN o, si no hay, el motivo de GTIN vacío
    if (this.gtin.trim()) {
      out.push({ id: 'GTIN', value_name: this.gtin.trim() });
    } else if (this.gtinReasons.length > 0) {
      out.push({ id: 'EMPTY_GTIN_REASON', value_id: this.emptyGtinReason || EMPTY_GTIN_DEFAULT_REASON });
    }

    this.extraAttributes.forEach(e => {
      if (!out.some(o => o.id === e.id)) { out.push(e); }
    });
    return out;
  }

  private buildSaleTerms(): any[] {
    const terms: any[] = [{ id: 'WARRANTY_TYPE', value_name: this.warrantyType }];
    if (this.warrantyType !== 'Sin garantía' && this.warrantyTime.trim()) {
      terms.push({ id: 'WARRANTY_TIME', value_name: this.warrantyTime.trim() });
    }
    return terms.concat(this.otherSaleTerms);
  }

  private buildPictures(): Array<{ id?: string; source?: string }> {
    const fromSelector = this.validatedPictureIds.filter(p => p.url);
    if (fromSelector.length > 0) {
      return fromSelector.slice(0, this.maxPictures).map(p => p.id ? { id: p.id } : { source: p.url! });
    }
    if (this.picturesText.trim()) {
      return this.picturesText.split('\n').map(u => u.trim()).filter(Boolean).slice(0, this.maxPictures).map(source => ({ source }));
    }
    return this.duplicatePictureIds.map(id => ({ id }));
  }

  /** Payloads a publicar: uno, o uno por variación (modelo User Products). */
  private buildPayloads(): Array<{ label: string; payload: any }> {
    const base = {
      family_name: this.familyName.trim(),
      category_id: this.categoryId,
      price: Number(this.price),
      currency_id: 'MXN',
      available_quantity: Number(this.quantity),
      buying_mode: 'buy_it_now',
      condition: this.condition,
      listing_type_id: this.listingTypeId,
      sale_terms: this.buildSaleTerms(),
      shipping: { mode: 'me2', local_pick_up: this.localPickUp, free_shipping: this.freeShipping },
      description: this.description
    };
    const attributes = this.buildAttributes();
    const pictures = this.buildPictures();

    const included = this.variations.filter(v => v.include && !v.unresolved);
    if (included.length === 0) {
      return [{ label: this.familyName.trim(), payload: { ...base, attributes, pictures } }];
    }
    return included.map(v => {
      const varAttrs = v.attributes;
      const merged = attributes.filter(a => !varAttrs.some(x => x.id === a.id)).concat(varAttrs);
      const varPics = v.pictureIds.length > 0 ? v.pictureIds.slice(0, this.maxPictures).map(id => ({ id })) : pictures;
      return {
        label: v.label,
        payload: { ...base, price: Number(v.price), available_quantity: Number(v.quantity), attributes: merged, pictures: varPics }
      };
    });
  }

  // =====================================================
  // Validar (POST /api/items/validate -> ML /items/validate, no publica)
  // =====================================================

  async onValidate(): Promise<void> {
    if (this.validating || this.submitting) { return; }
    this.formErrors = [];
    this.validationResult = null;
    if (!this.localValidate()) {
      this.setLocalErrorBanner();
      return;
    }
    this.validating = true;
    const payloads = this.buildPayloads();
    const errors: ErrorCause[] = [];
    const warnings: ErrorCause[] = [];
    try {
      for (const p of payloads) {
        const r: any = await firstValueFrom(this.http.post(`${environment.apiUrl}/items/validate`, p.payload));
        const prefix = payloads.length > 1 ? `[${p.label}] ` : '';
        (r.errors || []).forEach((e: ErrorCause) => errors.push({ ...e, message: prefix + e.message }));
        (r.warnings || []).forEach((w: ErrorCause) => warnings.push({ ...w, message: prefix + w.message }));
      }
      this.validationResult = { valid: errors.length === 0, errors, warnings };
    } catch (err) {
      const e = this.parseHttpError(err, 'No se pudo validar la publicación');
      this.formErrorTitle = 'No se pudo validar';
      this.formErrors = e.causes.length ? e.causes : [{ code: 'error', message: e.message }];
    } finally {
      this.validating = false;
    }
  }

  private setLocalErrorBanner(): void {
    this.formErrorTitle = 'Revisa los campos marcados antes de continuar';
    this.formErrors = Object.entries(this.attributeErrors).map(([k, m]) => ({
      code: k, message: `${this.fieldLabel(k)}: ${m}`
    }));
  }

  private fieldLabel(k: string): string {
    const map: { [k: string]: string } = {
      family_name: 'Nombre', category: 'Categoría', price: 'Precio', quantity: 'Cantidad',
      height: 'Alto', width: 'Ancho', length: 'Largo', weight: 'Peso'
    };
    return map[k] || this.categoryAttributes.find(a => a.id === k)?.name || k;
  }

  // =====================================================
  // Publicar (nunca reintenta un create que ya salió bien)
  // =====================================================

  async onSubmit(): Promise<void> {
    if (this.submitting) { return; }                 // anti doble clic
    this.formErrors = [];
    this.validationResult = null;
    if (!this.localValidate()) {
      this.setLocalErrorBanner();
      return;
    }
    if (!this.jobs.some(j => j.status === 'created' || j.status === 'unknown')) {
      this.jobs = this.buildPayloads().map(p => ({
        label: p.label, payload: p.payload, status: 'pending' as JobStatus, causes: [],
        description: p.payload.description || '', descriptionState: 'none' as const
      }));
    }
    await this.runJobs();
  }

  /** Publica solo los trabajos pendientes o fallidos. Los 'created' y 'unknown' no se vuelven a enviar. */
  private async runJobs(): Promise<void> {
    this.submitting = true;
    this.showResult = true;
    try {
      for (const job of this.jobs) {
        if (job.status !== 'pending' && job.status !== 'failed') { continue; }
        job.status = 'creating';
        job.causes = [];
        job.error = undefined;
        try {
          const r: any = await firstValueFrom(this.http.post(`${environment.apiUrl}/items`, job.payload));
          job.status = 'created';
          job.itemId = r.item?.id;
          job.permalink = r.item?.permalink;
          if (!job.description.trim()) { job.descriptionState = 'none'; }
          else if (r.description?.ok === false) { job.descriptionState = 'failed'; job.descriptionError = r.description.error; }
          else { job.descriptionState = 'ok'; }
        } catch (err) {
          const e = this.parseHttpError(err, 'Error al publicar');
          job.error = e.message;
          job.causes = e.causes;
          // Sin respuesta (red) o 5xx: puede que ML sí haya creado el item. No se reintenta solo.
          job.status = e.status === 0 || e.status >= 500 ? 'unknown' : 'failed';
        }
      }
    } finally {
      this.submitting = false;
    }
    this.cachingService.invalidatePattern(/\/items/i);
    if (this.jobs.every(j => j.status === 'created' && j.descriptionState !== 'failed')) {
      this.clearDraft();
    }
  }

  async retryFailedJobs(): Promise<void> {
    if (this.submitting) { return; }
    await this.runJobs();
  }

  /** Marca como 'failed' un job 'unknown' después de que el usuario verificó que no existe en Publicaciones. */
  confirmNotCreated(job: PublishJob): void {
    if (job.status === 'unknown') { job.status = 'failed'; }
  }

  async retryDescription(job: PublishJob): Promise<void> {
    if (!job.itemId || job.descriptionState === 'retrying') { return; }
    job.descriptionState = 'retrying';
    try {
      await firstValueFrom(this.http.post(`${environment.apiUrl}/items/${encodeURIComponent(job.itemId)}/description`, { plain_text: job.description }));
      job.descriptionState = 'ok';
      job.descriptionError = undefined;
    } catch (err) {
      job.descriptionState = 'failed';
      job.descriptionError = this.parseHttpError(err, 'No se pudo guardar la descripción').message;
    }
    if (this.jobs.every(j => j.status === 'created' && j.descriptionState !== 'failed')) { this.clearDraft(); }
  }

  get hasRetryableJobs(): boolean { return this.jobs.some(j => j.status === 'failed' || j.status === 'pending'); }
  get allDone(): boolean { return this.jobs.length > 0 && this.jobs.every(j => j.status === 'created' && j.descriptionState !== 'failed' && j.descriptionState !== 'retrying'); }
  get createdCount(): number { return this.jobs.filter(j => j.status === 'created').length; }

  backToForm(): void { this.showResult = false; }

  goToPublications(): void { this.router.navigate(['/publications']); }

  newPublication(): void {
    this.jobs = [];
    this.showResult = false;
    this.clearDraft();
    this.router.navigate(['/publish'], { queryParams: {} }).then(() => this.resetForm());
  }

  resetForm(): void {
    this.suppressDraft = true;
    this.familyName = ''; this.originalFamilyName = ''; this.categoryId = ''; this.categoryName = ''; this.categoryPath = '';
    this.price = null; this.quantity = 1; this.condition = 'new'; this.listingTypeId = 'gold_special';
    this.description = ''; this.freeShipping = false; this.localPickUp = false; this.warrantyType = 'Garantía del vendedor'; this.warrantyTime = '90 días';
    this.otherSaleTerms = []; this.package = { height: null, width: null, length: null, weight: null, weightUnit: 'g' };
    this.attributeValues = {}; this.attributeErrors = {}; this.extraAttributes = []; this.gtin = ''; this.categoryAttributes = []; this.allCategoryAttributes = [];
    this.variations = []; this.validatedPictureIds = []; this.picturesText = ''; this.duplicatePictureIds = []; this.fees = [];
    this.formErrors = []; this.validationResult = null; this.isDuplicateMode = false; this.sourceId = '';
    this.selectorReady = false;
    setTimeout(() => { this.selectorReady = true; this.suppressDraft = false; });
  }

  // =====================================================
  // Borrador en localStorage
  // =====================================================

  scheduleSave(): void {
    if (this.suppressDraft || this.showResult) { return; }
    if (this.saveTimer) { clearTimeout(this.saveTimer); }
    this.saveTimer = setTimeout(() => this.saveDraft(), 400);
  }

  private saveDraft(): void {
    if (this.isDuplicateMode && !this.sourceId) { return; }
    const draft = {
      v: 1, savedAt: Date.now(),
      familyName: this.familyName, categoryId: this.categoryId, categoryName: this.categoryName,
      price: this.price, quantity: this.quantity, condition: this.condition, listingTypeId: this.listingTypeId,
      description: this.description, freeShipping: this.freeShipping, localPickUp: this.localPickUp,
      warrantyType: this.warrantyType, warrantyTime: this.warrantyTime, package: this.package,
      attributeValues: this.attributeValues, gtin: this.gtin, emptyGtinReason: this.emptyGtinReason,
      variations: this.variations.map(v => ({ key: v.key, include: v.include, price: v.price, quantity: v.quantity })),
      picturesText: this.picturesText
    };
    try { localStorage.setItem(this.draftKey, JSON.stringify(draft)); } catch { /* cuota llena: se ignora */ }
  }

  private restoreDraft(): void {
    let raw: string | null = null;
    try { raw = localStorage.getItem(this.draftKey); } catch { return; }
    if (!raw) { return; }
    try {
      const d = JSON.parse(raw);
      if (!d || d.v !== 1) { return; }
      if (!this.isDuplicateMode && !d.familyName && !d.price) { return; }
      this.suppressDraft = true;
      this.familyName = d.familyName ?? this.familyName;
      this.price = d.price ?? this.price;
      this.quantity = d.quantity ?? this.quantity;
      this.condition = d.condition ?? this.condition;
      this.listingTypeId = d.listingTypeId ?? this.listingTypeId;
      this.description = d.description ?? this.description;
      this.freeShipping = d.freeShipping ?? this.freeShipping;
      this.localPickUp = d.localPickUp ?? this.localPickUp;
      this.warrantyType = d.warrantyType ?? this.warrantyType;
      this.warrantyTime = d.warrantyTime ?? this.warrantyTime;
      this.package = d.package ?? this.package;
      this.attributeValues = { ...this.attributeValues, ...(d.attributeValues || {}) };
      this.gtin = d.gtin ?? this.gtin;
      this.emptyGtinReason = d.emptyGtinReason ?? this.emptyGtinReason;
      this.picturesText = d.picturesText ?? '';
      (d.variations || []).forEach((dv: any) => {
        const v = this.variations.find(x => x.key === dv.key);
        if (v) { v.include = dv.include && !v.unresolved; v.price = dv.price; v.quantity = dv.quantity; }
      });
      this.draftRestored = true;
      if (!this.isDuplicateMode && d.categoryId && d.categoryId !== this.categoryId) {
        this.categoryId = d.categoryId;
        this.categoryName = d.categoryName || '';
        this.loadCategoryContext(d.categoryId).then(() => { this.attributeValues = { ...this.attributeValues, ...(d.attributeValues || {}) }; this.queueFees(); });
      }
      this.queueFees();
    } finally {
      this.suppressDraft = false;
    }
  }

  clearDraft(): void {
    try { localStorage.removeItem(this.draftKey); } catch { /* ignore */ }
    this.draftRestored = false;
  }

  /** "Descartar borrador": borra lo guardado y recarga el formulario desde el original (o vacío). */
  discardDraft(): void {
    this.clearDraft();
    if (this.isDuplicateMode && this.sourceId) {
      this.loadDuplicateData(this.sourceId);
    } else {
      this.resetForm();
    }
  }

  // =====================================================
  // Utilidades
  // =====================================================

  get nameOverLimit(): boolean { return this.familyName.length > 60; }
  get sameNameAsOriginal(): boolean {
    return this.isDuplicateMode && !!this.originalFamilyName && this.familyName.trim() === this.originalFamilyName.trim();
  }

  get requiredAttributes(): CategoryAttribute[] {
    return this.categoryAttributes.filter(a => a.tags.required || a.tags.catalog_required);
  }
  get optionalAttributes(): CategoryAttribute[] {
    return this.categoryAttributes.filter(a => !(a.tags.required || a.tags.catalog_required));
  }
  showOptionalAttrs = false;

  isRequired(a: CategoryAttribute): boolean { return !!(a.tags.required || a.tags.catalog_required); }

  private parseHttpError(err: unknown, fallback: string): { message: string; status: number; causes: ErrorCause[] } {
    if (err instanceof HttpErrorResponse) {
      const body: any = err.error;
      const causes: ErrorCause[] = Array.isArray(body?.causes) ? body.causes : [];
      const message = err.status === 0
        ? 'No hay conexión con el servidor'
        : (body?.error || body?.message || fallback);
      return { message: String(message), status: err.status, causes };
    }
    return { message: fallback, status: 0, causes: [] };
  }

  trackByIndex(i: number): number { return i; }
}
