import { Component, OnDestroy, OnInit } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom, Subject, Subscription } from 'rxjs';
import { debounceTime, distinctUntilChanged } from 'rxjs/operators';
import { ActivatedRoute, Router } from '@angular/router';
import { environment } from '../../environments/environment';
import { CategoryPredictorService, CategoryPrediction, CategoryAttribute } from '../services/category-predictor.service';
import { CachingService } from '../services/caching.service';
import { satRetention } from '../shared/order-math';
import { DuplicateQueueService } from '../shared/duplicate-queue.service';
import {
  EMPTY_GTIN_DEFAULT_REASON, FALLBACK_MAX_PICTURES, ListingTemplateService, PackageForm, VariationDraft, WARRANTY_TYPES
} from '../shared/listing-template.service';

/** Causa de error devuelta por el backend (preserva el código de ML). */
export interface ErrorCause { code: string; message: string; type?: string; }

export interface ListingFee {
  listing_type_id: string;
  listing_type_name: string;
  sale_fee_amount: number;
  percentage_fee: number | null;
  fixed_fee: number;
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

const DRAFT_PREFIX = 'publish-draft:';

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
  /** Nombre sugerido (query param `name`, p. ej. desde Oportunidades): solo precarga el campo, el usuario lo revisa. */
  private suggestedName = '';
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
    private cachingService: CachingService,
    private dupQueue: DuplicateQueueService,
    private tpl: ListingTemplateService
  ) { }

  /** Cola de duplicado en bloque (Publicaciones > Duplicar con varias seleccionadas) */
  get queuePos(): { index: number; total: number; nextId: string | null } | null {
    return this.isDuplicateMode && this.sourceId ? this.dupQueue.position(this.sourceId) : null;
  }

  goNextInQueue(): void {
    const q = this.queuePos;
    if (q?.nextId) this.router.navigate(['/publish'], { queryParams: { mode: 'duplicate', from: q.nextId } });
  }

  cancelQueue(): void { this.dupQueue.clear(); }

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
        const nm = params['name'];
        this.suggestedName = typeof nm === 'string' ? nm.replace(/\s+/g, ' ').trim().slice(0, 60) : '';
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
      const { item, description } = await this.tpl.fetchSource(id);
      const m = this.tpl.mapSourceItem(item, description);
      this.sourceStatus = m.sourceStatus;

      this.originalFamilyName = m.originalFamilyName;
      this.familyName = this.suggestedName || this.originalFamilyName.slice(0, 60);
      this.categoryId = m.categoryId;
      this.price = m.price;
      this.quantity = m.quantity;
      this.condition = m.condition;
      this.description = m.description;
      this.listingTypeId = m.listingTypeId;
      if (m.listingTypeNote) { this.listingTypeNote = m.listingTypeNote; }
      this.freeShipping = m.freeShipping;
      this.localPickUp = m.localPickUp;
      if (m.fulfillmentNote) { this.fulfillmentNote = m.fulfillmentNote; }
      this.warrantyType = m.warrantyType;
      this.warrantyTime = m.warrantyTime;
      this.otherSaleTerms = m.otherSaleTerms;

      // Fotos: se copian por id (ya alojadas en ML), hasta el máximo de la categoría
      const pics = m.pictures;
      Object.assign(this.pictureThumbs, m.pictureThumbs);
      this.originalItemImages = pics;

      // Atributos del original
      this.hydrateFromItemAttributes(item.attributes || []);

      // Variaciones legacy -> publicaciones separadas
      this.variations = m.variations;

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

  /** Copia todos los atributos del original que el formulario sabe mostrar o que deben conservarse. */
  private hydrateFromItemAttributes(attrs: any[]): void {
    this.extraAttributes = [];
    this.attributeValues = {};
    this.gtin = '';
    const h = this.tpl.hydrateAttributes(attrs, this.package);
    this.skuCleared = h.skuCleared;
    this.gtin = h.gtin;
    if (h.emptyGtinReason) { this.emptyGtinReason = h.emptyGtinReason; }
    Object.assign(this.attributeValues, h.raw);
  }

  /** Una vez cargados los atributos de la categoría, mapea los valores crudos del original a los controles. */
  private applyRawAttributeValues(): void {
    const rawKeys = Object.keys(this.attributeValues).filter(k => k.startsWith('__raw_'));
    const raws = rawKeys.map(k => this.attributeValues[k]);
    rawKeys.forEach(k => delete this.attributeValues[k]);
    const r = this.tpl.resolveRawAttributes(raws, this.categoryAttributes, this.allCategoryAttributes);
    Object.assign(this.attributeValues, r.values);
    this.extraAttributes.push(...r.extra);
  }

  // =====================================================
  // Categoría: atributos, límites y comisiones
  // =====================================================

  private async loadCategoryContext(categoryId: string): Promise<void> {
    this.isLoadingAttributes = true;
    try {
      const ctx = await this.tpl.loadCategoryContext(categoryId);
      if (ctx.cat) {
        this.categoryName = ctx.cat.name || this.categoryName;
        this.categoryPath = ctx.cat.path;
        this.maxPictures = ctx.cat.maxPictures;
      }
      this.allCategoryAttributes = ctx.allAttributes;
      this.hasGtinAttr = ctx.hasGtinAttr;
      this.gtinReasons = ctx.gtinReasons;
      this.categoryAttributes = ctx.displayedAttributes;
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
  get weightInGrams(): number | null { return this.tpl.weightInGrams(this.package); }

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
    return this.tpl.buildAttributes({
      pkg: this.package, weightInGrams: this.weightInGrams, categoryAttributes: this.categoryAttributes,
      attributeValues: this.attributeValues, gtin: this.gtin, gtinReasons: this.gtinReasons,
      emptyGtinReason: this.emptyGtinReason, extraAttributes: this.extraAttributes
    });
  }

  private buildSaleTerms(): any[] {
    return this.tpl.buildSaleTerms(this.warrantyType, this.warrantyTime, this.otherSaleTerms);
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
      const merged = this.tpl.mergeVariationAttributes(attributes, varAttrs);
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
