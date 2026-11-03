import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';
import { CategoryAttribute, CategoryPredictorService } from '../services/category-predictor.service';

/**
 * Lógica compartida para convertir una publicación existente de ML en la "plantilla" de otra
 * (Duplicar y Cargas masivas): lectura fresca, mapeo de atributos, empaque, términos de venta,
 * variaciones y construcción de los atributos/términos del payload. Extraída de PublishProductComponent
 * sin cambiar su comportamiento.
 */

export const WARRANTY_TYPES = ['Garantía del vendedor', 'Garantía de fábrica', 'Sin garantía'];
export const PACKAGE_IDS = ['SELLER_PACKAGE_HEIGHT', 'SELLER_PACKAGE_WIDTH', 'SELLER_PACKAGE_LENGTH', 'SELLER_PACKAGE_WEIGHT'];
export const EMPTY_GTIN_DEFAULT_REASON = '17055160'; // "El producto no tiene código registrado" (MLM)
export const FALLBACK_MAX_PICTURES = 12;

export interface VariationDraft {
  key: number;
  include: boolean;
  label: string;
  price: number;
  quantity: number;
  pictureIds: string[];
  attributes: Array<{ id: string; value_id?: string; value_name: string }>;
  unresolved: boolean;      // algún atributo de la combinación no trae ID usable
}

export interface PackageForm {
  height: number | null;
  width: number | null;
  length: number | null;
  weight: number | null;
  weightUnit: 'g' | 'kg';
}

export interface RawAttribute { id: string; value_id?: string; value_name?: string; struct: any; }
export type PayloadAttribute = { id: string; value_id?: string; value_name?: string };

/** Campos de la publicación original ya mapeados a los del formulario. */
export interface MappedSource {
  sourceStatus: string;
  originalFamilyName: string;
  categoryId: string;
  price: number;
  quantity: number;
  condition: 'new' | 'used';
  description: string;
  listingTypeId: 'gold_special' | 'gold_pro';
  listingTypeNote: string;
  freeShipping: boolean;
  localPickUp: boolean;
  fulfillmentNote: string;
  warrantyType: string;
  warrantyTime: string;
  otherSaleTerms: Array<{ id: string; value_id?: string; value_name?: string }>;
  pictures: any[];
  pictureThumbs: { [id: string]: string };
  variations: VariationDraft[];
}

export interface HydratedAttributes {
  raw: { [id: string]: RawAttribute };
  gtin: string;
  emptyGtinReason: string | null;
  skuCleared: boolean;
}

export interface CategoryContext {
  cat: { name: string; path: string; maxPictures: number } | null;
  allAttributes: CategoryAttribute[];
  displayedAttributes: CategoryAttribute[];
  hasGtinAttr: boolean;
  gtinReasons: Array<{ id: string; name: string }>;
}

export interface AttributeBuildInput {
  pkg: PackageForm;
  weightInGrams: number | null;
  categoryAttributes: CategoryAttribute[];
  attributeValues: { [key: string]: any };
  gtin: string;
  gtinReasons: Array<{ id: string; name: string }>;
  emptyGtinReason: string;
  extraAttributes: PayloadAttribute[];
}

@Injectable({ providedIn: 'root' })
export class ListingTemplateService {
  constructor(private http: HttpClient, private categoryPredictor: CategoryPredictorService) {}

  /** Siempre se pide el item fresco a ML (nunca la fila de la lista). La descripción es opcional. */
  async fetchSource(id: string): Promise<{ item: any; description: string }> {
    const item: any = await firstValueFrom(this.http.get<any>(`${environment.apiUrl}/items/${encodeURIComponent(id)}`));
    let description = '';
    try {
      const d: any = await firstValueFrom(this.http.get<any>(`${environment.apiUrl}/items/${encodeURIComponent(id)}/description`));
      description = d?.plain_text || '';
    } catch { description = ''; }
    return { item, description };
  }

  /** Mapea el item de ML a los campos del formulario (sin atributos de categoría, que se resuelven aparte). */
  mapSourceItem(item: any, description: string): MappedSource {
    let listingTypeId: 'gold_special' | 'gold_pro';
    let listingTypeNote = '';
    if (item.listing_type_id === 'gold_pro') {
      listingTypeId = 'gold_pro';
    } else {
      listingTypeId = 'gold_special';
      if (item.listing_type_id !== 'gold_special') {
        listingTypeNote = `El original usa "${item.listing_type_id}", que ya no se ofrece: se eligió Clásica.`;
      }
    }

    let fulfillmentNote = '';
    if (item.shipping?.logistic_type === 'fulfillment') {
      fulfillmentNote = 'El original se envía con Full. La copia se publica con envío del vendedor (Full no se copia) y el stock lo defines tú.';
    }

    // Garantía y otros términos de venta (por id, no por posición)
    const terms: any[] = Array.isArray(item.sale_terms) ? item.sale_terms : [];
    const wType = terms.find(t => t.id === 'WARRANTY_TYPE');
    const wTime = terms.find(t => t.id === 'WARRANTY_TIME');
    const warrantyType = wType?.value_name && WARRANTY_TYPES.includes(wType.value_name) ? wType.value_name : 'Sin garantía';
    const otherSaleTerms = terms
      .filter(t => t.id !== 'WARRANTY_TYPE' && t.id !== 'WARRANTY_TIME')
      .map(t => t.value_id ? { id: t.id, value_id: t.value_id } : { id: t.id, value_name: t.value_name });

    // Fotos: se copian por id (ya alojadas en ML)
    const pics: any[] = Array.isArray(item.pictures) ? item.pictures : [];
    const pictureThumbs: { [id: string]: string } = {};
    pics.forEach(p => { pictureThumbs[p.id] = p.secure_url || p.url; });

    // Variaciones legacy -> publicaciones separadas
    const variations: VariationDraft[] = (item.variations || []).map((v: any, i: number) => this.mapVariation(v, i));
    (item.variations || []).forEach((v: any) => (v.picture_ids || []).forEach((pid: string) => {
      const pic = pics.find(p => p.id === pid);
      if (pic) { pictureThumbs[pid] = pic.secure_url || pic.url; }
    }));

    let quantity = item.available_quantity > 0 ? item.available_quantity : 1;
    if (variations.length > 0) {
      quantity = variations.reduce((s, v) => s + (v.include ? v.quantity : 0), 0) || 1;
    }

    return {
      sourceStatus: item.status || '',
      originalFamilyName: (item.family_name || item.title || '').toString(),
      categoryId: item.category_id,
      price: item.price,
      quantity,
      condition: item.condition === 'used' ? 'used' : 'new',
      description,
      listingTypeId,
      listingTypeNote,
      freeShipping: !!item.shipping?.free_shipping,
      localPickUp: !!item.shipping?.local_pick_up,
      fulfillmentNote,
      warrantyType,
      warrantyTime: wTime?.value_name || '',
      otherSaleTerms,
      pictures: pics,
      pictureThumbs,
      variations,
    };
  }

  mapVariation(v: any, i: number): VariationDraft {
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

  /**
   * Atributos del original que el formulario sabe mostrar o que deben conservarse.
   * Muta `pkg` con las medidas del paquete (igual que el formulario original).
   */
  hydrateAttributes(attrs: any[], pkg: PackageForm): HydratedAttributes {
    const out: HydratedAttributes = { raw: {}, gtin: '', emptyGtinReason: null, skuCleared: false };
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
      if (id === 'SELLER_SKU') { out.skuCleared = true; return; }     // debe ser único: no se copia
      if (id === 'GTIN') { if (a.value_id !== '-1' && a.value_name) { out.gtin = String(a.value_name); } return; }
      if (id === 'EMPTY_GTIN_REASON') { if (a.value_id) { out.emptyGtinReason = String(a.value_id); } return; }
      if (a.value_id === '-1' || (!a.value_id && !a.value_name)) { return; }
      out.raw['__raw_' + id] = { id, value_id: a.value_id || undefined, value_name: a.value_name, struct };
    });
    return out;
  }

  /** Detalle y atributos de la categoría; los atributos visibles se ordenan (requeridos primero). */
  async loadCategoryContext(categoryId: string): Promise<CategoryContext> {
    const [cat, attrs] = await Promise.all([
      firstValueFrom(this.categoryPredictor.getCategoryDetails(categoryId)).catch(() => null),
      firstValueFrom(this.categoryPredictor.getCategoryAttributes(categoryId))
    ]);
    const reason = attrs.find(a => a.id === 'EMPTY_GTIN_REASON');
    const displayed = attrs
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
    return {
      cat: cat ? {
        name: cat.name || '',
        path: (cat.path_from_root || []).map((p: any) => p.name).join(' › '),
        maxPictures: cat.settings?.max_pictures_per_item || FALLBACK_MAX_PICTURES
      } : null,
      allAttributes: attrs,
      displayedAttributes: displayed,
      hasGtinAttr: attrs.some(a => a.id === 'GTIN'),
      gtinReasons: (reason?.values || []).map(v => ({ id: v.id, name: v.name })),
    };
  }

  /** Mapea los valores crudos del original (clave `__raw_ID`) a los controles de los atributos de la categoría. */
  resolveRawAttributes(
    raws: RawAttribute[], displayedAttributes: CategoryAttribute[], allAttributes: CategoryAttribute[]
  ): { values: { [key: string]: any }; extra: PayloadAttribute[] } {
    const values: { [key: string]: any } = {};
    const extra: PayloadAttribute[] = [];
    const displayed = new Map(displayedAttributes.map(a => [a.id, a] as const));
    const all = new Map(allAttributes.map(a => [a.id, a] as const));
    raws.forEach(raw => {
      const def = displayed.get(raw.id);
      if (!def) {
        const full = all.get(raw.id);
        // Atributos ocultos pero no de solo lectura se conservan tal cual
        if (full && !full.tags.read_only) {
          extra.push(raw.value_id ? { id: raw.id, value_id: raw.value_id } : { id: raw.id, value_name: raw.value_name });
        }
        return;
      }
      switch (def.value_type) {
        case 'list': {
          let opt = raw.value_id ? def.values?.find(v => v.id === raw.value_id) : undefined;
          if (!opt) { opt = def.values?.find(v => v.name?.toLowerCase() === String(raw.value_name).toLowerCase()); }
          if (opt) { values[def.id] = opt.id; }
          else if (raw.value_name) { extra.push({ id: raw.id, value_name: raw.value_name }); }
          break;
        }
        case 'number_unit': {
          const n = raw.struct?.number ?? parseFloat(String(raw.value_name));
          const unit = raw.struct?.unit || String(raw.value_name).split(' ')[1] || def.default_unit || def.allowed_units?.[0]?.id;
          values[def.id + '_number'] = n;
          values[def.id + '_unit'] = unit;
          break;
        }
        case 'number':
          values[def.id] = raw.struct?.number ?? parseFloat(String(raw.value_name));
          break;
        case 'boolean': {
          const opt = def.values?.find(v => v.id === raw.value_id);
          values[def.id] = opt ? opt.name === 'Sí' : String(raw.value_name).toLowerCase().startsWith('s');
          break;
        }
        default:
          values[def.id] = raw.value_name;
      }
    });
    return { values, extra };
  }

  /** Peso en gramos enteros según la unidad elegida. */
  weightInGrams(pkg: PackageForm): number | null {
    const w = Number(pkg.weight);
    if (!w || w <= 0) { return null; }
    return Math.max(1, Math.round(pkg.weightUnit === 'kg' ? w * 1000 : w));
  }

  buildAttributes(input: AttributeBuildInput): any[] {
    const out: any[] = [];
    const pkg = input.pkg;
    const int = (n: any) => Math.max(1, Math.round(Number(n)));
    out.push({ id: 'SELLER_PACKAGE_HEIGHT', value_name: `${int(pkg.height)} cm` });
    out.push({ id: 'SELLER_PACKAGE_WIDTH', value_name: `${int(pkg.width)} cm` });
    out.push({ id: 'SELLER_PACKAGE_LENGTH', value_name: `${int(pkg.length)} cm` });
    out.push({ id: 'SELLER_PACKAGE_WEIGHT', value_name: `${input.weightInGrams} g` });

    input.categoryAttributes.forEach(a => {
      const v = input.attributeValues[a.id];
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
          const n = input.attributeValues[a.id + '_number'];
          const u = input.attributeValues[a.id + '_unit'];
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
    if (input.gtin.trim()) {
      out.push({ id: 'GTIN', value_name: input.gtin.trim() });
    } else if (input.gtinReasons.length > 0) {
      out.push({ id: 'EMPTY_GTIN_REASON', value_id: input.emptyGtinReason || EMPTY_GTIN_DEFAULT_REASON });
    }

    input.extraAttributes.forEach(e => {
      if (!out.some(o => o.id === e.id)) { out.push(e); }
    });
    return out;
  }

  buildSaleTerms(warrantyType: string, warrantyTime: string, otherSaleTerms: PayloadAttribute[]): any[] {
    const terms: any[] = [{ id: 'WARRANTY_TYPE', value_name: warrantyType }];
    if (warrantyType !== 'Sin garantía' && warrantyTime.trim()) {
      terms.push({ id: 'WARRANTY_TIME', value_name: warrantyTime.trim() });
    }
    return terms.concat(otherSaleTerms);
  }

  /** Atributos de una variación mezclados sobre los generales (los de la variación mandan). */
  mergeVariationAttributes(attributes: any[], variationAttrs: Array<{ id: string }>): any[] {
    return attributes.filter(a => !variationAttrs.some(x => x.id === a.id)).concat(variationAttrs as any[]);
  }
}
