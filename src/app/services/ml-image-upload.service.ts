import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';

/**
 * Response de la API de Upload de MercadoLibre
 */
export interface MLUploadResponse {
  id: string;           // picture_id para usar en publicación
  variations?: Array<{  // Variaciones de la imagen
    size: string;
    url: string;
    secure_url: string;
  }>;
  size?: string;        // Tamaño (ej: "500x500")
  max_size?: string;    // Tamaño máximo
  quality?: string;     // Calidad de la imagen
}

/**
 * Servicio para subir imágenes al CDN de MercadoLibre
 */
@Injectable({ providedIn: 'root' })
export class MLImageUploadService {
  private readonly UPLOAD_API = `${environment.apiUrl}/images/upload`;

  constructor(private http: HttpClient) {}

  /**
   * Sube una imagen al CDN de MercadoLibre
   * @param file - Archivo de imagen a subir
   * @returns Promise con la respuesta de ML incluyendo picture_id
   */
  async uploadImage(file: File): Promise<MLUploadResponse> {
    const formData = new FormData();
    formData.append('file', file);

    try {
      console.log('[MLImageUploadService] Subiendo imagen a CDN de MercadoLibre...');

      const response = await firstValueFrom(
        this.http.post<MLUploadResponse>(this.UPLOAD_API, formData)
      );

      console.log('[MLImageUploadService] ✅ Imagen subida exitosamente:', response.id);

      return response;

    } catch (error: any) {
      console.error('[MLImageUploadService] Error al subir imagen:', error);
      throw new Error(`Error al subir imagen: ${error.message || 'Error desconocido'}`);
    }
  }

  /**
   * Sube múltiples imágenes en paralelo
   * @param files - Array de archivos a subir
   * @returns Promise con array de respuestas
   */
  async uploadMultipleImages(files: File[]): Promise<MLUploadResponse[]> {
    console.log(`[MLImageUploadService] Subiendo ${files.length} imágenes...`);

    const uploadPromises = files.map(file => this.uploadImage(file));

    try {
      const results = await Promise.all(uploadPromises);
      console.log(`[MLImageUploadService] ✅ ${results.length} imágenes subidas exitosamente`);
      return results;
    } catch (error) {
      console.error('[MLImageUploadService] Error al subir múltiples imágenes:', error);
      throw error;
    }
  }

  /**
   * Sube múltiples imágenes en secuencia (una por una)
   * Útil para evitar rate limiting
   */
  async uploadMultipleImagesSequential(files: File[]): Promise<MLUploadResponse[]> {
    console.log(`[MLImageUploadService] Subiendo ${files.length} imágenes secuencialmente...`);

    const results: MLUploadResponse[] = [];

    for (let i = 0; i < files.length; i++) {
      console.log(`[MLImageUploadService] Subiendo imagen ${i + 1}/${files.length}...`);
      try {
        const result = await this.uploadImage(files[i]);
        results.push(result);

        // Pequeña pausa entre uploads para evitar rate limiting
        if (i < files.length - 1) {
          await this.delay(500); // 500ms entre cada upload
        }
      } catch (error) {
        console.error(`[MLImageUploadService] Error subiendo imagen ${i + 1}:`, error);
        throw error;
      }
    }

    console.log(`[MLImageUploadService] ✅ ${results.length} imágenes subidas exitosamente`);
    return results;
  }

  /**
   * Helper para pausas
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
