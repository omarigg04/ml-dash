import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { ImageValidationService } from './image-validation.service';
import { environment } from '../../environments/environment';

/**
 * Request para API de Diagnóstico ML
 */
interface MLDiagnosticRequest {
  picture_url: string; // URL, Base64, o picture_id - todo va aquí
  context: {
    category_id: string;
    picture_type: 'thumbnail' | 'variation_thumbnail' | 'other';
    title?: string; // Título de la publicación para mejor contexto
  };
}

/**
 * Response de API de Diagnóstico ML
 */
export interface MLDiagnosticResponse {
  id?: string;
  picture_hash?: string;
  diagnostics: Array<{
    picture_type: string;
    action: 'diagnostic' | 'empty';
    detections: Array<{
      kind: string;
      wordings: Array<{
        value: string;
      }>;
    }>;
  }>;
}

/**
 * Servicio para validar imágenes usando la API de Diagnóstico de MercadoLibre
 */
@Injectable({ providedIn: 'root' })
export class MLImageDiagnosticService {
  private readonly DIAGNOSTIC_API = `${environment.apiUrl}/images/diagnostic`;

  constructor(
    private http: HttpClient,
    private imageValidator: ImageValidationService
  ) { }

  /**
   * Valida una imagen usando la API de MercadoLibre
   * @param imageData - File, URL string, picture_id, o base64
   * @param categoryId - ID de categoría ML
   * @param pictureType - Tipo de imagen (thumbnail, variation_thumbnail, other)
   * @param itemTitle - Título de la publicación (opcional, mejora la validación)
   */
  async validateImage(
    imageData: string | File,
    categoryId: string,
    pictureType: 'thumbnail' | 'variation_thumbnail' | 'other' = 'thumbnail',
    itemTitle?: string
  ): Promise<MLDiagnosticResponse> {
    // Determinar el valor de picture_url (puede ser URL, Base64, o picture_id)
    let pictureUrl: string;

    if (imageData instanceof File) {
      // Si es File, convertir a Base64
      pictureUrl = await this.imageValidator.imageToBase64(imageData);
    } else {
      // Si es string (URL, picture_id, o Base64), usar directamente
      pictureUrl = imageData;
    }

    // Preparar payload según la documentación de ML
    const payload: MLDiagnosticRequest = {
      picture_url: pictureUrl, // Todo va aquí: URL, Base64, o picture_id
      context: {
        category_id: categoryId,
        picture_type: pictureType,
        ...(itemTitle && { title: itemTitle }) // Incluir título si está disponible
      }
    };

    try {
      console.log('[MLImageDiagnosticService] Validando imagen con ML API...');
      console.log('[MLImageDiagnosticService] Payload:', {
        picture_url_type: imageData instanceof File ? 'base64' :
          (typeof imageData === 'string' && imageData.startsWith('http')) ? 'url' : 'picture_id',
        picture_url_length: pictureUrl.length,
        category_id: payload.context.category_id,
        picture_type: payload.context.picture_type
      });

      const response = await firstValueFrom(
        this.http.post<MLDiagnosticResponse>(this.DIAGNOSTIC_API, payload)
      );

      // La respuesta viene en array diagnostics
      const diagnostic = response.diagnostics?.[0];

      if (diagnostic?.action === 'empty') {
        console.log('[MLImageDiagnosticService] ✅ Imagen válida (sin problemas detectados)');
      } else {
        console.log('[MLImageDiagnosticService] ⚠️ Problemas detectados:', diagnostic?.detections);
      }

      return response;

    } catch (error: any) {
      console.error('[MLImageDiagnosticService] Error validando imagen:', error);

      // IMPORTANTE: Si la API falla, permitir continuar con advertencia
      // No queremos bloquear el flujo si ML API está caída
      console.warn('[MLImageDiagnosticService] API falló, permitiendo continuar');

      return {
        diagnostics: [
          {
            picture_type: pictureType,
            action: 'empty',
            detections: []
          }
        ]
      };
    }
  }

  /**
   * Extrae mensajes de error de la respuesta de ML
   */
  extractErrorMessages(response: MLDiagnosticResponse): string[] {
    const messages: string[] = [];

    response.diagnostics?.forEach(diagnostic => {
      if (diagnostic.action !== 'empty') {
        diagnostic.detections?.forEach(detection => {
          detection.wordings?.forEach(wording => {
            messages.push(wording.value);
          });
        });
      }
    });

    return messages;
  }

  /**
   * Verifica si la imagen pasó la validación
   */
  isImageValid(response: MLDiagnosticResponse): boolean {
    return response.diagnostics?.every(d => d.action === 'empty') ?? false;
  }

  /**
   * Obtiene el tipo de problemas detectados
   */
  getDetectionKinds(response: MLDiagnosticResponse): string[] {
    const kinds: string[] = [];

    response.diagnostics?.forEach(diagnostic => {
      diagnostic.detections?.forEach(detection => {
        kinds.push(detection.kind);
      });
    });

    return kinds;
  }
}
