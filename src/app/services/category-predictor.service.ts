import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
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
 * Servicio para predecir categorías usando el predictor de ML
 */
@Injectable({ providedIn: 'root' })
export class CategoryPredictorService {
  private readonly API_URL = `${environment.apiUrl}/categories`;

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
}
