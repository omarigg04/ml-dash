import { Component } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { AuthService } from '../../services/auth.service';

@Component({
  selector: 'app-login',
  templateUrl: './login.component.html',
  styleUrls: ['./login.component.scss']
})
export class LoginComponent {
  isLoading = false;
  errorMessage = '';
  returnUrl = '/';

  constructor(
    private authService: AuthService,
    private route: ActivatedRoute
  ) {
    const params = this.route.snapshot.queryParams;
    // Obtener URL de retorno si existe
    this.returnUrl = params['returnUrl'] || '/';
    this.errorMessage = this.getErrorMessage(params['error'], params['uid']);
  }

  onLogin(): void {
    this.isLoading = true;
    this.authService.login(this.returnUrl);
  }

  // Errores que el backend manda en /login?error=... desde el callback de OAuth
  private getErrorMessage(error?: string, uid?: string): string {
    switch (error) {
      case undefined:
        return '';
      case 'not_allowed':
        return `La cuenta de MercadoLibre (user_id ${uid}) no tiene acceso a este dashboard. ` +
          'Si es tu cuenta, configura ALLOWED_ML_USER_ID con ese valor en Vercel.';
      case 'invalid_state':
        return 'La sesión de autorización expiró. Intenta de nuevo.';
      default:
        return 'No se pudo iniciar sesión con MercadoLibre. Intenta de nuevo.';
    }
  }
}
