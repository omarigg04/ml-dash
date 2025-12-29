import { Component, OnInit, Output, EventEmitter, Input, ViewChild, ElementRef } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { ImagePublicationFlowService } from '../../services/image-publication-flow.service';
import { MLImageDiagnosticService } from '../../services/ml-image-diagnostic.service';
import { firstValueFrom } from 'rxjs';

/**
 * Interfaz para imagen seleccionada
 */
export interface SelectedImage {
  source: 'upload' | 'gallery' | 'url';
  pictureId?: string;
  file?: File;
  url?: string; // URL completa de la imagen en ML (para usar en pictures.source)
  preview: string;
  validated: boolean;
  validationErrors?: string[];
}

/**
 * Interfaz para imagen de galería
 */
interface GalleryImage {
  pictureId: string;
  url: string; // URL de alta calidad para validación
  thumbnailUrl?: string; // URL de thumbnail para mostrar en galería
  title?: string;
  width?: number;
  height?: number;
  validated?: boolean;
  tags?: string[];
}

/**
 * Componente selector multi-fuente de imágenes
 * Permite seleccionar imágenes de 3 fuentes:
 * 1. Upload nuevo
 * 2. Galería existente
 * 3. URL directa
 */
@Component({
  selector: 'app-image-source-selector',
  templateUrl: './image-source-selector.component.html',
  styleUrls: ['./image-source-selector.component.scss']
})
export class ImageSourceSelectorComponent implements OnInit {
  @Input() categoryId: string = 'MLB1234'; // ID de categoría ML (requerido)
  @Input() itemTitle: string = ''; // Título de la publicación (opcional)
  @Input() maxImages: number = 10; // Máximo número de imágenes permitidas
  @Input() initialImages: any[] = []; // Imágenes iniciales del producto (para modo duplicar)

  @Output() onImagesValidated = new EventEmitter<Array<{ id: string; url?: string }>>();
  @Output() onValidationStart = new EventEmitter<void>();
  @Output() onValidationComplete = new EventEmitter<void>();

  @ViewChild('fileInput') fileInput!: ElementRef<HTMLInputElement>;

  // Tabs
  selectedTab = 0;

  // Imágenes seleccionadas (de cualquier fuente)
  selectedImages: SelectedImage[] = [];

  // Gallery
  galleryImages: GalleryImage[] = [];
  filteredGalleryImages: GalleryImage[] = [];
  gallerySearchTerm = '';
  totalGalleryImages = 0;
  pageSize = 12;
  currentPage = 0;
  isLoadingGallery = false;

  // URL
  imageUrl = '';
  urlPreview: string | null = null;

  // Validation
  isValidating = false;
  validationProgress = 0;

  constructor(
    private http: HttpClient,
    private flow: ImagePublicationFlowService,
    private diagnostic: MLImageDiagnosticService
  ) {}

  ngOnInit() {
    console.log('[ImageSourceSelector] ngOnInit - categoryId:', this.categoryId);
    this.loadGallery();
    this.loadInitialImages();
  }

  // ============ TAB 1: Upload ============

  onFileInputClick() {
    this.fileInput.nativeElement.click();
  }

  async onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.files?.length) return;

    for (let i = 0; i < input.files.length; i++) {
      const file = input.files[i];
      await this.addFileToSelection(file);
    }

    // Limpiar input para permitir seleccionar el mismo archivo nuevamente
    input.value = '';
  }

  async addFileToSelection(file: File) {
    if (this.selectedImages.length >= this.maxImages) {
      alert(`Máximo ${this.maxImages} imágenes permitidas`);
      return;
    }

    const preview = URL.createObjectURL(file);

    this.selectedImages.push({
      source: 'upload',
      file: file,
      preview: preview,
      validated: false
    });
  }

  onDrop(event: DragEvent) {
    event.preventDefault();
    const files = event.dataTransfer?.files;

    if (files?.length) {
      Array.from(files).forEach(file => {
        if (file.type.startsWith('image/')) {
          this.addFileToSelection(file);
        }
      });
    }
  }

  onDragOver(event: DragEvent) {
    event.preventDefault();
  }

  // ============ TAB 2: Gallery ============

  async loadGallery() {
    this.isLoadingGallery = true;

    try {
      // Cargar imágenes de la galería desde localStorage
      const storedImages = localStorage.getItem('mlImageGallery');

      if (storedImages) {
        const images = JSON.parse(storedImages);

        this.galleryImages = images.map((img: any) => ({
          pictureId: img.id || img.pictureId, // El ID es el picture_id de ML
          url: img.fullSizeUrl || img.thumbnailUrl || img.url, // URL de alta calidad para validación
          thumbnailUrl: img.thumbnailUrl || img.url, // Thumbnail para preview en galería
          title: img.title || img.id || 'Sin título', // Usar ID como título si no hay title
          width: 200, // Tamaño estándar de thumbnail
          height: 200,
          validated: false, // Necesitan validarse para la categoría específica
          tags: img.tags || []
        }));

        this.filteredGalleryImages = [...this.galleryImages];
        this.totalGalleryImages = this.galleryImages.length;

        console.log(`[ImageSourceSelector] Galería cargada: ${this.galleryImages.length} imágenes desde localStorage`);
      } else {
        console.log('[ImageSourceSelector] No hay imágenes en la galería');
        this.galleryImages = [];
        this.filteredGalleryImages = [];
        this.totalGalleryImages = 0;
      }

    } catch (error) {
      console.error('[ImageSourceSelector] Error loading gallery:', error);
      this.galleryImages = [];
      this.filteredGalleryImages = [];
      this.totalGalleryImages = 0;
    } finally {
      this.isLoadingGallery = false;
    }
  }

  /**
   * Carga imágenes iniciales del producto (modo duplicar)
   */
  loadInitialImages() {
    if (!this.initialImages || this.initialImages.length === 0) {
      return;
    }

    console.log(`[ImageSourceSelector] Cargando ${this.initialImages.length} imágenes iniciales del producto`);

    this.initialImages.forEach((img: any, index: number) => {
      // Las imágenes vienen con estructura: {id, url, secure_url, size, ...}
      const imageUrl = img.secure_url || img.url;
      const pictureId = img.id;

      if (imageUrl) {
        this.selectedImages.push({
          source: 'gallery', // Marcar como galería ya que ya están en ML
          pictureId: pictureId,
          url: imageUrl,
          preview: imageUrl,
          validated: false // Necesitan validarse para la nueva categoría
        });
      }
    });

    console.log(`[ImageSourceSelector] ✅ ${this.selectedImages.length} imágenes del producto original cargadas`);
  }

  filterGallery() {
    if (!this.gallerySearchTerm.trim()) {
      this.filteredGalleryImages = [...this.galleryImages];
      return;
    }

    const term = this.gallerySearchTerm.toLowerCase();
    this.filteredGalleryImages = this.galleryImages.filter(img =>
      img.title?.toLowerCase().includes(term) ||
      img.tags?.some(tag => tag.toLowerCase().includes(term))
    );
  }

  selectFromGallery(image: GalleryImage) {
    if (this.selectedImages.length >= this.maxImages) {
      alert(`Máximo ${this.maxImages} imágenes permitidas`);
      return;
    }

    // Toggle selection
    const index = this.selectedImages.findIndex(img =>
      img.source === 'gallery' && img.pictureId === image.pictureId
    );

    if (index >= 0) {
      // Deseleccionar
      this.selectedImages.splice(index, 1);
    } else {
      // Seleccionar
      this.selectedImages.push({
        source: 'gallery',
        pictureId: image.pictureId,
        url: image.url, // URL de alta calidad para validación
        preview: image.thumbnailUrl || image.url, // Thumbnail para preview rápido
        validated: image.validated || false
      });
    }
  }

  isImageSelected(image: GalleryImage): boolean {
    return this.selectedImages.some(img =>
      img.source === 'gallery' && img.pictureId === image.pictureId
    );
  }

  refreshGallery() {
    this.loadGallery();
  }

  onPageChange(event: any) {
    this.currentPage = event.pageIndex;
    // La paginación la maneja mat-paginator automáticamente
  }

  getPaginatedGalleryImages(): GalleryImage[] {
    const start = this.currentPage * this.pageSize;
    const end = start + this.pageSize;
    return this.filteredGalleryImages.slice(start, end);
  }

  // ============ TAB 3: URL ============

  isValidUrl(url: string): boolean {
    if (!url) return false;

    try {
      new URL(url);
      return url.match(/\.(jpg|jpeg|png)$/i) !== null;
    } catch {
      return false;
    }
  }

  onUrlChange() {
    if (this.isValidUrl(this.imageUrl)) {
      this.urlPreview = this.imageUrl;
    } else {
      this.urlPreview = null;
    }
  }

  async loadFromUrl() {
    if (!this.isValidUrl(this.imageUrl)) return;

    if (this.selectedImages.length >= this.maxImages) {
      alert(`Máximo ${this.maxImages} imágenes permitidas`);
      return;
    }

    this.selectedImages.push({
      source: 'url',
      url: this.imageUrl,
      preview: this.imageUrl,
      validated: false
    });

    this.imageUrl = '';
    this.urlPreview = null;
  }

  // ============ Selected Images Management ============

  removeImage(index: number) {
    const img = this.selectedImages[index];

    // Revocar URL si es upload
    if (img.source === 'upload' && img.preview.startsWith('blob:')) {
      URL.revokeObjectURL(img.preview);
    }

    this.selectedImages.splice(index, 1);
  }

  moveImage(index: number, direction: number) {
    const newIndex = index + direction;
    if (newIndex < 0 || newIndex >= this.selectedImages.length) return;

    const temp = this.selectedImages[index];
    this.selectedImages[index] = this.selectedImages[newIndex];
    this.selectedImages[newIndex] = temp;
  }

  getSourceLabel(source: string): string {
    const labels: { [key: string]: string } = {
      'upload': 'Nueva',
      'gallery': 'Galería',
      'url': 'URL'
    };
    return labels[source] || source;
  }

  // ============ Validation ============

  async validateAllImages() {
    if (this.selectedImages.length === 0) {
      alert('No hay imágenes para validar');
      return;
    }

    console.log('🔍 [ImageSourceSelector] INICIANDO VALIDACIÓN DE IMÁGENES');
    console.log(`📊 Total de imágenes a validar: ${this.selectedImages.length}`);
    console.log(`🏷️ Category ID: ${this.categoryId}`);
    console.log('📋 Imágenes seleccionadas:', this.selectedImages);

    this.isValidating = true;
    this.validationProgress = 0;
    this.onValidationStart.emit();

    const totalImages = this.selectedImages.length;

    for (let i = 0; i < this.selectedImages.length; i++) {
      const img = this.selectedImages[i];
      console.log(`\n🖼️ [${i + 1}/${totalImages}] Procesando imagen:`);
      console.log(`   - Fuente: ${img.source}`);
      console.log(`   - Ya validada: ${img.validated}`);

      if (img.validated) {
        // Ya está validada, skip
        console.log(`   ✅ Ya estaba validada, saltando...`);
        this.validationProgress = Math.round(((i + 1) / totalImages) * 100);
        continue;
      }

      try {
        let result;

        if (img.source === 'upload' && img.file) {
          // Validar y subir nueva imagen
          console.log(`   📤 Procesando nueva imagen (${img.file.name})...`);
          result = await this.flow.processImageForPublication(
            img.file,
            this.categoryId,
            i === 0 ? 'thumbnail' : 'other',
            this.itemTitle
          );

          console.log(`   📊 Resultado:`, result);

          if (result.success) {
            img.pictureId = result.pictureId;
            img.url = result.imageUrl; // Guardar la URL también
            img.validated = true;
            img.validationErrors = [];
            console.log(`   ✅ Imagen validada y subida. Picture ID: ${result.pictureId}`);
            console.log(`   🌐 URL: ${result.imageUrl}`);
          } else {
            img.validated = false;
            img.validationErrors = result.errors;
            console.log(`   ❌ Validación falló:`, result.errors);
          }

        } else if (img.source === 'gallery' && img.url) {
          // Ya está en ML, validar usando la URL de la imagen
          console.log(`   🔍 Validando imagen de galería (${img.pictureId})...`);
          console.log(`   🌐 URL de imagen: ${img.url}`);
          result = await this.flow.validateImageFromUrl(
            img.url,
            this.categoryId,
            i === 0 ? 'thumbnail' : 'other',
            this.itemTitle
          );

          console.log(`   📊 Resultado:`, result);
          img.validated = result.success;
          img.validationErrors = result.errors;

          if (result.success) {
            // La URL ya está en img.url, solo asegurarnos de que se mantenga
            console.log(`   ✅ Imagen de galería validada con URL: ${img.url}`);
          } else {
            console.log(`   ❌ Validación falló:`, result.errors);
          }

        } else if (img.source === 'url' && img.url) {
          // Validar URL directa
          console.log(`   🌐 Validando imagen desde URL (${img.url})...`);
          result = await this.flow.validateImageFromUrl(
            img.url,
            this.categoryId,
            i === 0 ? 'thumbnail' : 'other',
            this.itemTitle
          );

          console.log(`   📊 Resultado:`, result);
          img.validated = result.success;
          img.validationErrors = result.errors;

          if (result.success) {
            // La URL ya está en img.url
            console.log(`   ✅ Imagen URL validada: ${img.url}`);
          } else {
            console.log(`   ❌ Validación falló:`, result.errors);
          }
        }

      } catch (error: any) {
        console.error(`   💥 [ImageSourceSelector] Error validating image:`, error);
        img.validated = false;
        img.validationErrors = [error.message || 'Error desconocido'];
      }

      this.validationProgress = Math.round(((i + 1) / totalImages) * 100);
      console.log(`   📊 Progreso: ${this.validationProgress}%`);
    }

    this.isValidating = false;
    this.onValidationComplete.emit();

    // Emitir las imágenes validadas con URL (requerido para pictures.source)
    // El ID es opcional y solo para referencia
    const validatedImages = this.selectedImages
      .filter(img => img.validated && img.url) // Solo las que tienen URL
      .map(img => ({
        id: img.pictureId || '', // ID opcional (vacío si no existe)
        url: img.url // URL requerida para pictures.source
      }));

    console.log(`\n✅ [ImageSourceSelector] VALIDACIÓN COMPLETA`);
    console.log(`📊 Resultado: ${validatedImages.length}/${totalImages} imágenes validadas con URL`);
    console.log(`📋 Imágenes validadas:`, validatedImages);

    if (validatedImages.length === 0) {
      console.warn('⚠️ No hay imágenes validadas con URL para emitir');
    }

    this.onImagesValidated.emit(validatedImages);
  }

  getValidatedCount(): number {
    return this.selectedImages.filter(img => img.validated).length;
  }

  getImagesWithErrors(): SelectedImage[] {
    return this.selectedImages.filter(img =>
      img.validationErrors && img.validationErrors.length > 0
    );
  }

  hasErrors(): boolean {
    return this.selectedImages.some(img => img.validationErrors && img.validationErrors.length > 0);
  }

  // ============ Cleanup ============

  ngOnDestroy() {
    // Limpiar object URLs
    this.selectedImages.forEach(img => {
      if (img.source === 'upload' && img.preview.startsWith('blob:')) {
        URL.revokeObjectURL(img.preview);
      }
    });
  }
}
