import { Component, EventEmitter, Output } from '@angular/core';
import { environment } from '../../environments/environment';

@Component({
  selector: 'app-top-nav',
  templateUrl: './top-nav.component.html',
  styleUrls: ['./top-nav.component.scss']
})
export class TopNavComponent {
  @Output() menuToggle = new EventEmitter<void>();

  searchQuery = '';

  onMenuToggle() {
    this.menuToggle.emit();
  }

  onSearch() {
    if (this.searchQuery.trim()) {
      console.log('Searching for:', this.searchQuery);
      // Implementar lógica de búsqueda
    }
  }

  loginWithMercadoLibre(): void {
    // Redirect to backend OAuth endpoint
    window.location.href = `${environment.apiUrl}/auth`;
  }
}
