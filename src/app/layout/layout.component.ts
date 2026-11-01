import { Component, HostListener } from '@angular/core';

@Component({
  selector: 'app-layout',
  templateUrl: './layout.component.html',
  styleUrls: ['./layout.component.scss']
})
export class LayoutComponent {
  /** Menú lateral abierto (solo aplica en móvil/tablet; en escritorio siempre está visible). */
  navOpen = false;

  toggleNav(): void {
    this.navOpen = !this.navOpen;
  }

  closeNav(): void {
    this.navOpen = false;
  }

  @HostListener('window:resize')
  onResize(): void {
    if (window.innerWidth > 920) this.navOpen = false;
  }

  focusMain(event: Event): void {
    event.preventDefault();
    document.getElementById('contenido')?.focus();
  }
}
