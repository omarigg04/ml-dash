import { Injectable } from '@angular/core';

/**
 * Resultado de validación de imagen
 */
export interface ImageValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  imageData: {
    width: number;
    height: number;
    size: number;
    format: string;
  };
}

/**
 * Servicio para validación local de imágenes
 * Valida formato, tamaño y resolución antes de enviar a ML
 */
@Injectable({ providedIn: 'root' })
export class ImageValidationService {
  private readonly VALID_FORMATS = ['image/jpeg', 'image/jpg', 'image/png'];
  private readonly MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
  private readonly MIN_RESOLUTION = 500; // 500x500px
  private readonly RECOMMENDED_RESOLUTION = 1200; // 1200x1200px
  private readonly MAX_RESOLUTION = 1920; // 1920x1920px

  /**
   * Valida un archivo de imagen completo
   */
  async validateImageFile(file: File): Promise<ImageValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    // 1. Verificar formato
    if (!this.VALID_FORMATS.includes(file.type)) {
      errors.push('Formato no permitido. Use JPG o PNG.');
    }

    // 2. Verificar tamaño de archivo
    if (file.size > this.MAX_FILE_SIZE) {
      errors.push(`Imagen muy pesada. Máximo ${this.formatFileSize(this.MAX_FILE_SIZE)}.`);
    }

    // 3. Leer dimensiones
    const dimensions = await this.getImageDimensions(file);

    // 4. Verificar resolución mínima
    if (dimensions.width < this.MIN_RESOLUTION || dimensions.height < this.MIN_RESOLUTION) {
      errors.push(`Resolución muy baja. Mínimo ${this.MIN_RESOLUTION}x${this.MIN_RESOLUTION}px.`);
    }

    // 5. Advertir si no es óptima
    if (dimensions.width < this.RECOMMENDED_RESOLUTION || dimensions.height < this.RECOMMENDED_RESOLUTION) {
      warnings.push(`Resolución recomendada: ${this.RECOMMENDED_RESOLUTION}x${this.RECOMMENDED_RESOLUTION}px para mejor calidad.`);
    }

    // 6. Advertir si es muy grande (será redimensionada por ML)
    if (dimensions.width > this.MAX_RESOLUTION || dimensions.height > this.MAX_RESOLUTION) {
      warnings.push(`La imagen será redimensionada automáticamente por MercadoLibre (máx ${this.MAX_RESOLUTION}x${this.MAX_RESOLUTION}px).`);
    }

    // 7. Verificar aspect ratio cuadrado (recomendado)
    const aspectRatio = dimensions.width / dimensions.height;
    if (aspectRatio < 0.9 || aspectRatio > 1.1) {
      warnings.push('Se recomienda imagen cuadrada (1:1) para mejor presentación.');
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      imageData: {
        width: dimensions.width,
        height: dimensions.height,
        size: file.size,
        format: file.type
      }
    };
  }

  /**
   * Obtiene las dimensiones de una imagen
   */
  private getImageDimensions(file: File): Promise<{ width: number; height: number }> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);

      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve({
          width: img.naturalWidth,
          height: img.naturalHeight
        });
      };

      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('No se pudo leer la imagen'));
      };

      img.src = url;
    });
  }

  /**
   * Convierte imagen a Base64
   */
  imageToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  /**
   * Formatea tamaño de archivo para display
   */
  formatFileSize(bytes: number): string {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
  }

  /**
   * Verifica si un formato es válido
   */
  isValidFormat(mimeType: string): boolean {
    return this.VALID_FORMATS.includes(mimeType);
  }

  /**
   * Verifica si el tamaño es válido
   */
  isValidSize(bytes: number): boolean {
    return bytes <= this.MAX_FILE_SIZE;
  }

  /**
   * Verifica si la resolución es válida
   */
  isValidResolution(width: number, height: number): boolean {
    return width >= this.MIN_RESOLUTION && height >= this.MIN_RESOLUTION;
  }
}
