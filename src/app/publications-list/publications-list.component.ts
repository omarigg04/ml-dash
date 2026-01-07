import { Component, OnInit } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Router } from '@angular/router';
import { environment } from '../../environments/environment';

interface Publication {
  id: string;
  title: string;
  price: number;
  available_quantity: number;
  sold_quantity?: number; // Número de ventas del producto
  status: string;
  thumbnail: string | null;
  listing_type_id: string;
  condition: string;
  permalink: string;
  date_created: string;
  last_updated: string;
  fullData: any;
  visits?: number; // Número de visitas del producto
}

interface PagingInfo {
  total: number;
  offset: number;
  limit: number;
}

@Component({
  selector: 'app-publications-list',
  templateUrl: './publications-list.component.html',
  styleUrls: ['./publications-list.component.scss']
})
export class PublicationsListComponent implements OnInit {
  displayedColumns: string[] = ['thumbnail', 'title', 'price', 'stock', 'sales', 'visits', 'status', 'actions'];
  dataSource: Publication[] = [];
  isLoading = false;
  isLoadingMore = false;
  isLoadingVisits = false;

  // Filters
  searchQuery = '';
  statusFilter = '';
  listingTypeFilter = '';
  sortBy = '';

  // Pagination
  currentPage = 0;
  pageSize = 50;
  totalItems = 0;
  hasMore = false;

  // Filter options
  statusOptions = [
    { value: '', label: 'Todos los estados' },
    { value: 'active', label: 'Activos' },
    { value: 'paused', label: 'Pausados' },
    { value: 'closed', label: 'Cerrados' },
    { value: 'under_review', label: 'En revisión' },
    { value: 'inactive', label: 'Inactivos' }
  ];

  listingTypeOptions = [
    { value: '', label: 'Todos los tipos' },
    { value: 'gold_pro', label: 'Oro Pro' },
    { value: 'gold_premium', label: 'Oro Premium' },
    { value: 'gold_special', label: 'Oro Especial' },
    { value: 'silver', label: 'Plata' },
    { value: 'bronze', label: 'Bronce' },
    { value: 'free', label: 'Gratis' }
  ];

  sortOptions = [
    { value: '', label: 'Más relevantes' },
    { value: 'date_desc', label: 'Más recientes' },
    { value: 'date_asc', label: 'Más antiguos' },
    { value: 'price_asc', label: 'Menor precio' },
    { value: 'price_desc', label: 'Mayor precio' },
    { value: 'sales_desc', label: 'Más vendidos' },
    { value: 'sales_asc', label: 'Menos vendidos' },
    { value: 'title_asc', label: 'Título A-Z' },
    { value: 'title_desc', label: 'Título Z-A' },
    { value: 'stock_asc', label: 'Menor stock' },
    { value: 'stock_desc', label: 'Mayor stock' }
  ];

  constructor(
    private http: HttpClient,
    private router: Router
  ) {}

  ngOnInit(): void {
    this.loadPublications();
  }

  /**
   * Load publications with current filters
   */
  loadPublications(reset: boolean = true): void {
    if (reset) {
      this.dataSource = [];
      this.currentPage = 0;
    }

    this.isLoading = reset;
    this.isLoadingMore = !reset;

    const params = new HttpParams()
      .set('offset', (this.currentPage * this.pageSize).toString())
      .set('limit', this.pageSize.toString())
      .set('status', this.statusFilter)
      .set('listing_type', this.listingTypeFilter)
      .set('q', this.searchQuery)
      .set('sort', this.sortBy);

    this.http.get<{items: Publication[], paging: PagingInfo}>(`${environment.apiUrl}/items`, { params })
      .subscribe({
        next: (response) => {
          if (reset) {
            this.dataSource = response.items;
          } else {
            this.dataSource = [...this.dataSource, ...response.items];
          }

          this.totalItems = response.paging.total;
          this.hasMore = (response.paging.offset + response.paging.limit) < response.paging.total;

          this.isLoading = false;
          this.isLoadingMore = false;

          // Load visit counts for the items
          this.loadVisits(response.items);
        },
        error: (error) => {
          console.error('Error loading publications:', error);
          this.isLoading = false;
          this.isLoadingMore = false;
        }
      });
  }

  /**
   * Load visit counts for items
   */
  loadVisits(items: Publication[]): void {
    console.log('🔍 loadVisits called with', items.length, 'items');

    if (!items || items.length === 0) {
      console.log('⚠️ No items to load visits for');
      return;
    }

    this.isLoadingVisits = true;

    // Extract item IDs
    const itemIds = items.map(item => item.id).join(',');
    console.log('📋 Item IDs:', itemIds.substring(0, 100) + '...');

    const url = `${environment.apiUrl}/items/visits`;
    console.log('🌐 Calling URL:', url);
    console.log('📦 With params:', { ids: itemIds.substring(0, 50) + '...' });

    // Call visits endpoint
    this.http.get<{[key: string]: number}>(`${environment.apiUrl}/items/visits`, {
      params: new HttpParams().set('ids', itemIds)
    }).subscribe({
      next: (visitsData) => {
        console.log('✅ Visits data received:', visitsData);

        // Map visits to items
        this.dataSource = this.dataSource.map(item => ({
          ...item,
          visits: visitsData[item.id] || 0
        }));

        console.log('📊 Data source updated with visits');
        this.isLoadingVisits = false;
      },
      error: (error) => {
        console.error('❌ Error loading visits:', error);
        console.error('❌ Error status:', error.status);
        console.error('❌ Error message:', error.message);

        // Set visits to 0 if error
        this.dataSource = this.dataSource.map(item => ({
          ...item,
          visits: 0
        }));
        this.isLoadingVisits = false;
      }
    });
  }

  /**
   * Load more publications (pagination)
   */
  loadMore(): void {
    if (!this.hasMore || this.isLoadingMore) return;

    this.currentPage++;
    this.loadPublications(false);
  }

  /**
   * Apply search filter
   */
  onSearch(): void {
    this.loadPublications(true);
  }

  /**
   * Clear search
   */
  clearSearch(): void {
    this.searchQuery = '';
    this.loadPublications(true);
  }

  /**
   * Apply status filter
   */
  onStatusFilterChange(): void {
    this.loadPublications(true);
  }

  /**
   * Apply listing type filter
   */
  onListingTypeFilterChange(): void {
    this.loadPublications(true);
  }

  /**
   * Apply sort
   */
  onSortChange(): void {
    this.loadPublications(true);
  }

  /**
   * Clear all filters
   */
  clearFilters(): void {
    this.searchQuery = '';
    this.statusFilter = '';
    this.listingTypeFilter = '';
    this.sortBy = '';
    this.loadPublications(true);
  }

  /**
   * Check if any filters are active
   */
  hasActiveFilters(): boolean {
    return !!(this.searchQuery || this.statusFilter || this.listingTypeFilter || this.sortBy);
  }

  // Duplicate: Navigate to publish form with pre-filled data
  onDuplicate(item: Publication): void {
    // Store item data in sessionStorage
    sessionStorage.setItem('duplicateItem', JSON.stringify(item.fullData));
    // Navigate to publish page
    this.router.navigate(['/publish'], {
      queryParams: { mode: 'duplicate' }
    });
  }

  // Relist: For closed items only
  onRelist(item: Publication): void {
    if (item.status !== 'closed') {
      alert('Solo se pueden republicar items cerrados');
      return;
    }

    // Open dialog to edit price/quantity
    // For now, simple prompt (can enhance with MatDialog)
    const newPrice = prompt(`Nuevo precio para "${item.title}":`, item.price.toString());
    const newQuantity = prompt('Nueva cantidad:', item.available_quantity.toString());

    if (newPrice && newQuantity) {
      this.http.post(`${environment.apiUrl}/items/${item.id}/relist`, {
        price: parseFloat(newPrice),
        quantity: parseInt(newQuantity),
        listing_type_id: item.listing_type_id
      }).subscribe({
        next: (response: any) => {
          alert(`Publicación republicada exitosamente! Nuevo ID: ${response.newItem.id}`);
          this.loadPublications(); // Refresh list
        },
        error: (error) => {
          alert(`Error: ${error.error?.details || 'No se pudo republicar'}`);
        }
      });
    }
  }

  // Edit in-place (future enhancement)
  onEdit(item: Publication): void {
    // TODO: Implement inline editing or modal
    alert('Función de edición en desarrollo');
  }

  // View details
  onViewDetails(item: Publication): void {
    // TODO: Open modal with full item details
    window.open(item.permalink, '_blank');
  }

  // Status badge color
  getStatusColor(status: string): string {
    switch (status) {
      case 'active': return 'primary';
      case 'paused': return 'accent';
      case 'closed': return 'warn';
      default: return '';
    }
  }

  // Status label
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

  // Status icon (para mobile)
  getStatusIcon(status: string): string {
    const icons: any = {
      'active': 'check_circle',      // Palomita en círculo para activo
      'paused': 'pause_circle',      // Círculo con pausa
      'closed': 'cancel',            // X para cerrado
      'under_review': 'find_in_page', // Lupa en página para en revisión
      'inactive': 'remove_circle'    // Círculo con línea para inactivo
    };
    return icons[status] || 'help_outline';
  }

  // TrackBy function para evitar re-renderizado innecesario
  trackByItemId(index: number, item: Publication): string {
    return item.id;
  }

  // Handle image load error
  onImageError(item: Publication): void {
    item.thumbnail = null;
  }
}
