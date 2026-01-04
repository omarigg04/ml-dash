import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of } from 'rxjs';
import { tap } from 'rxjs/operators';
import { environment } from '../../environments/environment';

/**
 * Predicción de categoría retornada por ML
 */
export interface CategoryPrediction {
  domain_id: string;
  domain_name: string;
  category_id: string;
  category_name: string;
  attributes: any[];
}

/**
 * Respuesta del endpoint de predicción
 */
export interface CategoryPredictionResponse {
  query: string;
  predictions: CategoryPrediction[];
  total: number;
}

/**
 * Atributo de categoría retornado por ML
 */
export interface CategoryAttribute {
  id: string;
  name: string;
  tags: {
    required?: boolean;
    catalog_required?: boolean;
    hidden?: boolean;
    read_only?: boolean;
    multivalued?: boolean;
    allow_variations?: boolean;
    fixed?: boolean;
  };
  hierarchy: string;
  relevance: number;
  value_type: 'string' | 'list' | 'number' | 'number_unit' | 'boolean';
  value_max_length?: number;
  values?: Array<{
    id: string;
    name: string;
    metadata?: any;
  }>;
  allowed_units?: Array<{
    id: string;
    name: string;
  }>;
  default_unit?: string;
  tooltip?: string;
  hint?: string;
  attribute_group_id: string;
  attribute_group_name: string;
}

/**
 * Servicio para predecir categorías usando el predictor de ML
 */
@Injectable({ providedIn: 'root' })
export class CategoryPredictorService {
  private readonly API_URL = `${environment.apiUrl}/categories`;

  // Caché de atributos por category_id
  private attributesCache = new Map<string, CategoryAttribute[]>();

  constructor(private http: HttpClient) {}

  /**
   * Predice la categoría basándose en el título/nombre del producto
   * @param query - Título o nombre del producto
   * @param limit - Número de predicciones (1-8, default: 3)
   * @returns Observable con las predicciones
   */
  predictCategory(query: string, limit: number = 3): Observable<CategoryPredictionResponse> {
    console.log('[CategoryPredictor] Predicting category for:', query);

    return this.http.get<CategoryPredictionResponse>(`${this.API_URL}/predict`, {
      params: {
        q: query,
        limit: limit.toString()
      }
    });
  }

  /**
   * Obtiene detalles completos de una categoría
   * @param categoryId - ID de la categoría
   * @returns Observable con los detalles de la categoría
   */
  getCategoryDetails(categoryId: string): Observable<any> {
    console.log('[CategoryPredictor] Fetching category details for:', categoryId);

    return this.http.get<any>(`${this.API_URL}/${categoryId}`);
  }

  /**
   * Obtiene los atributos de una categoría con caché
   * @param categoryId - ID de la categoría
   * @returns Observable con array de atributos
   */
  getCategoryAttributes(categoryId: string): Observable<CategoryAttribute[]> {
    console.log('[CategoryPredictor] Fetching attributes for category:', categoryId);

    // Verificar caché primero
    if (this.attributesCache.has(categoryId)) {
      console.log('[CategoryPredictor] Returning cached attributes for:', categoryId);
      return of(this.attributesCache.get(categoryId)!);
    }

    // Fetch desde API y cachear
    return this.http.get<CategoryAttribute[]>(`${this.API_URL}/${categoryId}/attributes`).pipe(
      tap(attributes => {
        console.log(`[CategoryPredictor] Caching ${attributes.length} attributes for category:`, categoryId);
        this.attributesCache.set(categoryId, attributes);
      })
    );
  }

  /**
   * Limpia el caché de atributos
   */
  clearAttributesCache(): void {
    this.attributesCache.clear();
    console.log('[CategoryPredictor] Attributes cache cleared');
  }
}
