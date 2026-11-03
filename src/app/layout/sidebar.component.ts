import { Component, EventEmitter, Input, OnDestroy, OnInit, Output } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { NavigationEnd, Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { filter } from 'rxjs/operators';
import { environment } from '../../environments/environment';

interface NavItem {
  label: string;
  icon?: string;
  route: string;
  /** Subitem: se muestra indentado bajo el item anterior. */
  sub?: boolean;
  /** Insignia numérica (p. ej. órdenes por enviar). */
  badge?: 'pending';
}

@Component({
  selector: 'app-sidebar',
  templateUrl: './sidebar.component.html',
  styleUrls: ['./sidebar.component.scss']
})
export class SidebarComponent implements OnInit, OnDestroy {
  /** Panel abierto en móvil (lo controla LayoutComponent). */
  @Input() open = false;
  /** Se emite al navegar, para que el layout cierre el panel móvil. */
  @Output() navigated = new EventEmitter<void>();

  readonly items: NavItem[] = [
    { label: 'Inicio', icon: 'home', route: '/inicio' },
    { label: 'Órdenes', icon: 'receipt_long', route: '/orders', badge: 'pending' },
    { label: 'Publicaciones', icon: 'list_alt', route: '/publications' },
    { label: 'Publicar', route: '/publish', sub: true },
    { label: 'Galería', route: '/gallery', sub: true },
    { label: 'Analytics', icon: 'analytics', route: '/analytics' },
  ];

  /** Órdenes por enviar; null mientras no carga o si falló (la insignia se oculta). */
  pendingShipments: number | null = null;
  private navSub?: Subscription;
  private lastFetch = 0;

  constructor(private http: HttpClient, private router: Router) {}

  ngOnInit(): void {
    this.refreshPending();
    // El backend cachea 60 s; aquí se evita pedir más de una vez cada 30 s al navegar
    this.navSub = this.router.events.pipe(filter(e => e instanceof NavigationEnd)).subscribe(() => this.refreshPending());
  }

  ngOnDestroy(): void {
    this.navSub?.unsubscribe();
  }

  private refreshPending(): void {
    if (Date.now() - this.lastFetch < 30_000) return;
    this.lastFetch = Date.now();
    this.http.get<{ count: number }>(`${environment.apiUrl}/summary/pending`).subscribe({
      next: res => { this.pendingShipments = typeof res.count === 'number' ? res.count : null; },
      error: () => { this.pendingShipments = null; }
    });
  }

  readonly footItem: NavItem = { label: 'Configuración', icon: 'settings', route: '/settings' };
}
