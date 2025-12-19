import { Component, ViewChild } from '@angular/core';
import { SidebarComponent } from './sidebar.component';

@Component({
  selector: 'app-layout',
  templateUrl: './layout.component.html',
  styleUrls: ['./layout.component.scss']
})
export class LayoutComponent {
  @ViewChild(SidebarComponent) sidebar!: SidebarComponent;

  onMenuToggle() {
    if (this.sidebar) {
      this.sidebar.toggleMobileSidebar();
    }
  }
}
