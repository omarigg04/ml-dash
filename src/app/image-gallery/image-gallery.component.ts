import { Component, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../environments/environment';

interface ImageVariation {
  size: string;
  secure_url: string;
  url: string;
}

interface UploadedImage {
  id: string;
  fullSizeUrl: string;
  thumbnailUrl: string;
  variations: ImageVariation[];
  uploadDate: Date;
  status: string;
}

interface CatalogImage {
  picture_id: string;
  full_url: string;
  thumbnail_url: string;
  variations: any[];
  source_item: {
    id: string;
    title: string;
    status: string;
  };
  date_created: string;
}

@Component({
  selector: 'app-image-gallery',
  templateUrl: './image-gallery.component.html',
  styleUrls: ['./image-gallery.component.scss']
})
export class ImageGalleryComponent implements OnInit {
  // Upload tab
  images: UploadedImage[] = [];
  isLoading = false;
  isDragging = false;
  uploadProgress = 0;
  errorMessage = '';
  successMessage = '';

  // Catalog tab
  selectedTabIndex = 0;
  catalogImages: CatalogImage[] = [];
  filteredCatalogImages: CatalogImage[] = [];
  isCatalogLoading = false;
  catalogSearchQuery = '';
  catalogStatusFilter = '';
  catalogLastRefresh: Date | null = null;

  // Filter options
  statusOptions = [
    { value: '', label: 'Todos los estados' },
    { value: 'active', label: 'Activos' },
    { value: 'paused', label: 'Pausados' },
    { value: 'closed', label: 'Cerrados' }
  ];

  constructor(private http: HttpClient) {}

  ngOnInit(): void {
    this.loadImages();
    this.loadCatalogFromCache();
  }

  /**
   * Load images from localStorage
   */
  loadImages(): void {
    const storedImages = localStorage.getItem('mlImageGallery');
    if (storedImages) {
      this.images = JSON.parse(storedImages);
    }
  }

  /**
   * Save images to localStorage
   */
  saveImages(): void {
    localStorage.setItem('mlImageGallery', JSON.stringify(this.images));
  }

  /**
   * Handle drag over event
   */
  onDragOver(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragging = true;
  }

  /**
   * Handle drag leave event
   */
  onDragLeave(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragging = false;
  }

  /**
   * Handle file drop
   */
  onDrop(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.isDragging = false;

    const files = event.dataTransfer?.files;
    if (files && files.length > 0) {
      this.handleFiles(files);
    }
  }

  /**
   * Handle file input change
   */
  onFileSelect(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      this.handleFiles(input.files);
    }
  }

  /**
   * Process and upload files
   */
  handleFiles(files: FileList): void {
    // Validate file types
    const validTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
    const validFiles = Array.from(files).filter(file => validTypes.includes(file.type));

    if (validFiles.length === 0) {
      this.errorMessage = 'Por favor selecciona archivos de imagen válidos (JPG, PNG, GIF, WEBP)';
      return;
    }

    if (validFiles.length !== files.length) {
      this.errorMessage = `${files.length - validFiles.length} archivo(s) ignorado(s) por formato inválido`;
    }

    // Upload each file
    validFiles.forEach(file => this.uploadImage(file));
  }

  /**
   * Upload single image to ML CDN
   */
  uploadImage(file: File): void {
    this.isLoading = true;
    this.errorMessage = '';
    this.successMessage = '';
    this.uploadProgress = 0;

    const formData = new FormData();
    formData.append('file', file);

    this.http.post<any>(`${environment.apiUrl}/images/upload`, formData, {
      reportProgress: true,
      observe: 'events'
    }).subscribe({
      next: (event: any) => {
        if (event.type === 4) { // HttpEventType.Response
          const response = event.body;

          // Find the LARGEST image variation (highest quality)
          const extractSize = (sizeStr: string): number => {
            const match = sizeStr.match(/(\d+)x(\d+)/);
            return match ? Math.max(parseInt(match[1]), parseInt(match[2])) : 0;
          };

          let largestVariation = response.variations[0];
          let maxSize = 0;

          for (const variation of response.variations) {
            const size = extractSize(variation.size);
            if (size > maxSize) {
              maxSize = size;
              largestVariation = variation;
            }
          }

          // Find a thumbnail variation (using 200x200)
          const thumbnailVariation = response.variations.find((v: ImageVariation) =>
            v.size === '200x200'
          ) || response.variations[response.variations.length - 1];

          const uploadedImage: UploadedImage = {
            id: response.id,
            fullSizeUrl: largestVariation.secure_url,
            thumbnailUrl: thumbnailVariation.secure_url,
            variations: response.variations,
            uploadDate: new Date(),
            status: response.status
          };

          this.images.unshift(uploadedImage); // Add to beginning
          this.saveImages();
          this.successMessage = 'Imagen subida exitosamente!';
          this.isLoading = false;
          this.uploadProgress = 100;

          // Clear success message after 3 seconds
          setTimeout(() => {
            this.successMessage = '';
            this.uploadProgress = 0;
          }, 3000);
        }
      },
      error: (error) => {
        console.error('Error uploading image:', error);
        this.errorMessage = error.error?.message || 'Error al subir la imagen';
        this.isLoading = false;
        this.uploadProgress = 0;
      }
    });
  }

  /**
   * Copy URL to clipboard
   */
  copyUrl(url: string, type: 'full' | 'thumbnail'): void {
    navigator.clipboard.writeText(url).then(() => {
      this.successMessage = `URL ${type === 'full' ? 'completa' : 'miniatura'} copiada al portapapeles!`;
      setTimeout(() => this.successMessage = '', 2000);
    }).catch(err => {
      console.error('Error copying to clipboard:', err);
      this.errorMessage = 'Error al copiar URL';
    });
  }

  /**
   * Delete image from gallery
   */
  deleteImage(imageId: string): void {
    if (confirm('¿Estás seguro de que deseas eliminar esta imagen de la galería?')) {
      this.images = this.images.filter(img => img.id !== imageId);
      this.saveImages();
      this.successMessage = 'Imagen eliminada de la galería';
      setTimeout(() => this.successMessage = '', 2000);
    }
  }

  /**
   * Clear all messages
   */
  clearMessages(): void {
    this.errorMessage = '';
    this.successMessage = '';
  }

  // ===== CATALOG METHODS =====

  /**
   * Load catalog from cache
   */
  loadCatalogFromCache(): void {
    const cached = localStorage.getItem('mlImageCatalog');
    const cacheTimestamp = localStorage.getItem('mlImageCatalogTimestamp');

    if (cached && cacheTimestamp) {
      this.catalogImages = JSON.parse(cached);
      this.catalogLastRefresh = new Date(cacheTimestamp);
      this.applyFilters();
    }
  }

  /**
   * Fetch catalog from backend
   */
  fetchCatalog(forceRefresh: boolean = false): void {
    // Check if we have recent cache (less than 5 minutes old)
    if (!forceRefresh && this.catalogLastRefresh) {
      const cacheAge = Date.now() - this.catalogLastRefresh.getTime();
      if (cacheAge < 5 * 60 * 1000) { // 5 minutes
        this.successMessage = 'Usando catálogo en caché. Actualizado hace ' + Math.floor(cacheAge / 1000) + ' segundos';
        setTimeout(() => this.successMessage = '', 3000);
        return;
      }
    }

    this.isCatalogLoading = true;
    this.errorMessage = '';

    this.http.get<{images: CatalogImage[], total: number, unique_images: number, total_items: number}>
      (`${environment.apiUrl}/images/catalog`).subscribe({
      next: (response) => {
        this.catalogImages = response.images;
        this.catalogLastRefresh = new Date();

        // Save to cache
        localStorage.setItem('mlImageCatalog', JSON.stringify(this.catalogImages));
        localStorage.setItem('mlImageCatalogTimestamp', this.catalogLastRefresh.toISOString());

        this.applyFilters();
        this.isCatalogLoading = false;
        this.successMessage = `Catálogo actualizado: ${response.unique_images} imágenes únicas de ${response.total_items} publicaciones`;
        setTimeout(() => this.successMessage = '', 5000);
      },
      error: (error) => {
        console.error('Error fetching catalog:', error);
        this.errorMessage = error.error?.message || 'Error al cargar el catálogo de imágenes';
        this.isCatalogLoading = false;
      }
    });
  }

  /**
   * Handle tab change
   */
  onTabChange(index: number): void {
    this.selectedTabIndex = index;

    // Load catalog when switching to catalog tab for the first time
    if (index === 1 && this.catalogImages.length === 0) {
      this.fetchCatalog();
    }
  }

  /**
   * Apply filters to catalog
   */
  applyFilters(): void {
    let filtered = [...this.catalogImages];

    // Apply search filter
    if (this.catalogSearchQuery.trim()) {
      const query = this.catalogSearchQuery.toLowerCase();
      filtered = filtered.filter(img =>
        img.source_item.title.toLowerCase().includes(query) ||
        img.source_item.id.toLowerCase().includes(query)
      );
    }

    // Apply status filter
    if (this.catalogStatusFilter) {
      filtered = filtered.filter(img =>
        img.source_item.status === this.catalogStatusFilter
      );
    }

    this.filteredCatalogImages = filtered;
  }

  /**
   * Clear catalog filters
   */
  clearCatalogFilters(): void {
    this.catalogSearchQuery = '';
    this.catalogStatusFilter = '';
    this.applyFilters();
  }

  /**
   * Copy catalog image URL
   */
  copyCatalogUrl(url: string, type: 'full' | 'thumbnail'): void {
    navigator.clipboard.writeText(url).then(() => {
      this.successMessage = `URL ${type === 'full' ? 'completa' : 'miniatura'} copiada al portapapeles!`;
      setTimeout(() => this.successMessage = '', 2000);
    }).catch(err => {
      console.error('Error copying to clipboard:', err);
      this.errorMessage = 'Error al copiar URL';
    });
  }

  /**
   * Get status badge class
   */
  getStatusClass(status: string): string {
    return `status-${status.toLowerCase()}`;
  }

  /**
   * Get status label
   */
  getStatusLabel(status: string): string {
    const labels: any = {
      'active': 'Activa',
      'paused': 'Pausada',
      'closed': 'Cerrada',
      'under_review': 'En revisión',
      'inactive': 'Inactiva'
    };
    return labels[status] || status;
  }

  /**
   * View source item on MercadoLibre
   */
  viewSourceItem(itemId: string): void {
    window.open(`https://articulo.mercadolibre.com.mx/${itemId}`, '_blank');
  }
}
