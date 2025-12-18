import { Component, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { MatDialog } from '@angular/material/dialog';
import { environment } from '../../environments/environment';

interface Publication {
  id: string;
  title: string;
  price: number;
  available_quantity: number;
  status: string;
  thumbnail: string | null;
  listing_type_id: string;
  condition: string;
  permalink: string;
  fullData: any;
}

@Component({
  selector: 'app-publications-list',
  templateUrl: './publications-list.component.html',
  styleUrls: ['./publications-list.component.scss']
})
export class PublicationsListComponent implements OnInit {
  displayedColumns: string[] = ['thumbnail', 'title', 'price', 'stock', 'status', 'actions'];
  dataSource: Publication[] = [];
  isLoading = true;

  constructor(
    private http: HttpClient,
    private router: Router,
    public dialog: MatDialog
  ) {}

  ngOnInit(): void {
    this.loadPublications();
  }

  loadPublications(): void {
    this.isLoading = true;
    this.http.get<{items: Publication[]}>(`${environment.apiUrl}/items`)
      .subscribe({
        next: (response) => {
          this.dataSource = response.items;
          this.isLoading = false;
        },
        error: (error) => {
          console.error('Error loading publications:', error);
          this.isLoading = false;
        }
      });
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
}
