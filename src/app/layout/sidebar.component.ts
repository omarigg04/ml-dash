import { Component, EventEmitter, Input, Output } from '@angular/core';

interface NavItem {
  label: string;
  icon?: string;
  route: string;
  /** Subitem: se muestra indentado bajo el item anterior. */
  sub?: boolean;
}

@Component({
  selector: 'app-sidebar',
  templateUrl: './sidebar.component.html',
  styleUrls: ['./sidebar.component.scss']
})
export class SidebarComponent {
  /** Panel abierto en móvil (lo controla LayoutComponent). */
  @Input() open = false;
  /** Se emite al navegar, para que el layout cierre el panel móvil. */
  @Output() navigated = new EventEmitter<void>();

  readonly items: NavItem[] = [
    { label: 'Analytics', icon: 'analytics', route: '/analytics' },
    { label: 'Órdenes', icon: 'receipt_long', route: '/orders' },
    { label: 'Publicaciones', icon: 'list_alt', route: '/publications' },
    { label: 'Publicar', route: '/publish', sub: true },
    { label: 'Galería', route: '/gallery', sub: true },
  ];

  readonly footItem: NavItem = { label: 'Configuración', icon: 'settings', route: '/settings' };
}
