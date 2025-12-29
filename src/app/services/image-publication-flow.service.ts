import { Injectable } from '@angular/core';
import { ImageValidationService } from './image-validation.service';
import { MLImageDiagnosticService } from './ml-image-diagnostic.service';
import { MLImageUploadService } from './ml-image-upload.service';

/**
 * Resultado del proceso completo de validación y publicación
 */
export interface ImagePublicationResult {
  success: boolean;
  pictureId?: string;
  imageUrl?: string; // URL de la imagen para usar en pictures.source
  errors: string[];
  warnings: string[];
}

/**
 * Servicio que orquesta el flujo completo de validación y publicación de imágenes
 *
 * Flujo:
 * 1. Validación local (formato, tamaño, resolución)
 * 2. Validación con API de MercadoLibre
 * 3. Subida a CDN de MercadoLibre
 */
@Injectable({ providedIn: 'root' })
export class ImagePublicationFlowService {
  constructor(
    private validator: ImageValidationService,
    private diagnostic: MLImageDiagnosticService,
    private uploader: MLImageUploadService
  ) {}

  /**
   * Procesa una imagen completa: validación + upload
   * @param file - Archivo de imagen
   * @param categoryId - ID de categoría ML
   * @param pictureType - Tipo de imagen
   * @param itemTitle - Título de la publicación (opcional)
   * @returns Resultado con pictureId si es exitoso
   */
  async processImageForPublication(
    file: File,
    categoryId: string,
    pictureType: 'thumbnail' | 'variation_thumbnail' | 'other' = 'thumbnail',
    itemTitle?: string
  ): Promise<ImagePublicationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    // PASO 1: Validación local
    console.log('📋 [ImagePublicationFlow] Paso 1/3: Validación local...');
    const localValidation = await this.validator.validateImageFile(file);

    if (!localValidation.valid) {
      console.log('❌ [ImagePublicationFlow] Validación local falló');
      return {
        success: false,
        errors: localValidation.errors,
        warnings: localValidation.warnings
      };
    }

    warnings.push(...localValidation.warnings);
    console.log('✅ [ImagePublicationFlow] Validación local exitosa');

    // PASO 2: Subir a CDN de ML primero (para obtener URL)
    console.log('☁️ [ImagePublicationFlow] Paso 2/3: Subiendo a CDN...');
    let uploadResult;
    try {
      uploadResult = await this.uploader.uploadImage(file);
      console.log('✅ [ImagePublicationFlow] Imagen subida:', uploadResult.id);
    } catch (error: any) {
      console.error('❌ [ImagePublicationFlow] Error al subir imagen:', error);
      return {
        success: false,
        errors: [`Error al subir imagen: ${error.message}`],
        warnings
      };
    }

    // PASO 3: Validación con API de ML usando la URL
    console.log('🔍 [ImagePublicationFlow] Paso 3/3: Validación con MercadoLibre...');

    // Obtener la URL de la imagen desde variations
    const imageUrl = uploadResult.variations?.[0]?.secure_url || uploadResult.variations?.[0]?.url;

    if (!imageUrl) {
      console.warn('⚠️ No se pudo obtener URL de la imagen, saltando validación ML');
      return {
        success: true,
        pictureId: uploadResult.id,
        errors: [],
        warnings: ['No se pudo validar con ML API (URL no disponible), pero la imagen fue subida exitosamente']
      };
    }

    const mlValidation = await this.diagnostic.validateImage(imageUrl, categoryId, pictureType, itemTitle);

    const mlErrors = this.diagnostic.extractErrorMessages(mlValidation);
    if (mlErrors.length > 0) {
      console.log('⚠️ [ImagePublicationFlow] Validación ML detectó problemas (imagen ya subida)');
      warnings.push('Nota: La imagen ya fue subida a ML, pero tiene advertencias de validación');
      warnings.push(...mlErrors);
    } else {
      console.log('✅ [ImagePublicationFlow] Validación ML exitosa');
    }

    console.log('✅ [ImagePublicationFlow] Proceso completo exitoso:', uploadResult.id);

    return {
      success: true,
      pictureId: uploadResult.id,
      imageUrl: imageUrl, // Retornar la URL también
      errors: [],
      warnings
    };
  }

  /**
   * Procesa múltiples imágenes
   * @param files - Array de archivos
   * @param categoryId - ID de categoría ML
   * @param pictureType - Tipo de imagen
   * @returns Array de resultados
   */
  async processMultipleImages(
    files: File[],
    categoryId: string,
    pictureType: 'thumbnail' | 'variation_thumbnail' | 'other' = 'other'
  ): Promise<ImagePublicationResult[]> {
    console.log(`[ImagePublicationFlow] Procesando ${files.length} imágenes...`);

    const results: ImagePublicationResult[] = [];

    for (let i = 0; i < files.length; i++) {
      console.log(`[ImagePublicationFlow] Procesando imagen ${i + 1}/${files.length}...`);

      // La primera imagen es thumbnail, el resto son "other"
      const type = i === 0 ? 'thumbnail' : pictureType;

      const result = await this.processImageForPublication(files[i], categoryId, type);
      results.push(result);

      // Si falla una imagen, continuar con las demás
      if (!result.success) {
        console.warn(`[ImagePublicationFlow] Imagen ${i + 1} falló, continuando...`);
      }
    }

    const successCount = results.filter(r => r.success).length;
    console.log(`[ImagePublicationFlow] ✅ ${successCount}/${files.length} imágenes procesadas exitosamente`);

    return results;
  }

  /**
   * Valida una imagen existente por picture_id (de galería)
   * @param pictureId - ID de imagen ya en ML
   * @param categoryId - ID de categoría ML
   * @param pictureType - Tipo de imagen
   * @param itemTitle - Título de la publicación (opcional)
   * @returns Resultado de validación (sin upload)
   */
  async validateExistingImage(
    pictureId: string,
    categoryId: string,
    pictureType: 'thumbnail' | 'variation_thumbnail' | 'other' = 'thumbnail',
    itemTitle?: string
  ): Promise<ImagePublicationResult> {
    console.log(`[ImagePublicationFlow] Validando imagen existente: ${pictureId}`);

    const mlValidation = await this.diagnostic.validateImage(pictureId, categoryId, pictureType, itemTitle);

    const mlErrors = this.diagnostic.extractErrorMessages(mlValidation);

    if (mlErrors.length > 0) {
      return {
        success: false,
        pictureId: pictureId,
        errors: mlErrors,
        warnings: []
      };
    }

    console.log('✅ [ImagePublicationFlow] Imagen existente validada');

    // Nota: Para imágenes existentes (picture_id), retornamos también el picture_id
    // pero no la URL ya que se asume que ya está en ML
    return {
      success: true,
      pictureId: pictureId,
      imageUrl: undefined, // No hay URL nueva para imágenes existentes
      errors: [],
      warnings: []
    };
  }

  /**
   * Valida imagen desde URL
   * @param imageUrl - URL de la imagen
   * @param categoryId - ID de categoría ML
   * @param pictureType - Tipo de imagen
   * @param itemTitle - Título de la publicación (opcional)
   * @returns Resultado de validación (sin upload)
   */
  async validateImageFromUrl(
    imageUrl: string,
    categoryId: string,
    pictureType: 'thumbnail' | 'variation_thumbnail' | 'other' = 'thumbnail',
    itemTitle?: string
  ): Promise<ImagePublicationResult> {
    console.log(`[ImagePublicationFlow] Validando imagen desde URL: ${imageUrl}`);

    const mlValidation = await this.diagnostic.validateImage(imageUrl, categoryId, pictureType, itemTitle);

    const mlErrors = this.diagnostic.extractErrorMessages(mlValidation);

    if (mlErrors.length > 0) {
      return {
        success: false,
        errors: mlErrors,
        warnings: ['Nota: La imagen desde URL será usada directamente en pictures.source']
      };
    }

    console.log('✅ [ImagePublicationFlow] Imagen URL validada');

    return {
      success: true,
      imageUrl: imageUrl, // Retornar la URL validada
      errors: [],
      warnings: []
    };
  }
}
