import { Injectable } from '@angular/core';

export interface PublicationFilters {
  searchQuery: string;
  statusFilter: string;
  listingTypeFilter: string;
  sortBy: string;
}

const PUBLICATION_FILTERS_KEY = 'ml_dash_publication_filters';

/**
 * Preferencias del usuario guardadas en localStorage (app de un solo usuario)
 */
@Injectable({
  providedIn: 'root'
})
export class UserPreferencesService {

  /**
   * Guarda las preferencias de filtros de publicaciones
   */
  async savePublicationFilters(filters: PublicationFilters): Promise<void> {
    localStorage.setItem(PUBLICATION_FILTERS_KEY, JSON.stringify(filters));
  }

  /**
   * Obtiene las preferencias de filtros de publicaciones guardadas
   */
  async getPublicationFilters(): Promise<PublicationFilters | null> {
    try {
      const saved = localStorage.getItem(PUBLICATION_FILTERS_KEY);
      return saved ? JSON.parse(saved) as PublicationFilters : null;
    } catch {
      return null;
    }
  }

  /**
   * Elimina las preferencias de filtros de publicaciones
   */
  async deletePublicationFilters(): Promise<void> {
    localStorage.removeItem(PUBLICATION_FILTERS_KEY);
  }
}
