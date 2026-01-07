import { Component } from '@angular/core';
import { Router } from '@angular/router';

interface MenuItem {
  label: string;
  icon: string;
  route?: string;
  children?: MenuItem[];
  badge?: string | number;
  badgeType?: 'new' | 'count';
}

@Component({
  selector: 'app-sidebar',
  templateUrl: './sidebar.component.html',
  styleUrls: ['./sidebar.component.scss']
})
export class SidebarComponent {
  isCollapsed = false;
  isMobileOpen = false;

  menuItems: MenuItem[] = [
    {
      label: 'Analytics',
      icon: 'analytics',
      route: '/analytics'
    },
    {
      label: 'Publicar',
      icon: 'add_box',
      route: '/publish'
    },
    {
      label: 'Publicaciones',
      icon: 'list_alt',
      route: '/publications'
    },
    {
      label: 'Galería',
      icon: 'collections',
      route: '/gallery'
    },
    {
      label: 'Configuración',
      icon: 'settings',
      route: '/settings'
    }
  ];

  constructor(private router: Router) {}

  toggleSidebar() {
    this.isCollapsed = !this.isCollapsed;
  }

  toggleMobileSidebar() {
    this.isMobileOpen = !this.isMobileOpen;
  }

  navigateTo(route?: string) {
    if (route) {
      this.router.navigate([route]);
      // Close mobile sidebar after navigation
      if (window.innerWidth < 1322) {
        this.isMobileOpen = false;
      }
    }
  }

  isActiveRoute(route?: string): boolean {
    if (!route) return false;
    return this.router.url === route;
  }
}
