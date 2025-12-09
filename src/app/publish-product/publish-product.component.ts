import { Component } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../environments/environment';
import { Router } from '@angular/router';

@Component({
  selector: 'app-publish-product',
  templateUrl: './publish-product.component.html',
  styleUrls: ['./publish-product.component.scss']
})
export class PublishProductComponent {

  product = {
    title: "Producto de Prueba",
    category_id: "MLM1051",
    price: 100,
    available_quantity: 1,
    condition: "new",
    listing_type_id: "free",
    pictures: "", // Sin imágenes para prueba
    description: "", // Sin descripción para prueba
    warranty_type: "", // Sin garantía
    warranty_time: ""
  };


  // {
  //   title: 'Cable USB-C Premium 2 metros',
  //   category_id: 'MLM1051', // Default: Computación > Accesorios
  //   price: 199.99,
  //   available_quantity: 10,
  //   condition: 'new',
  //   pictures: '', // Dejar vacío por ahora para probar sin imágenes
  //   description: 'Cable USB-C de alta calidad con trenzado de nylon. Perfecto para carga rápida y transferencia de datos. Compatible con la mayoría de dispositivos móviles modernos.',
  //   listing_type_id: 'free', // free, bronze, silver, gold_special, gold_premium
  //   warranty_type: 'Garantía del vendedor',
  //   warranty_time: '6 meses'
  // };

  categories = [
    { id: 'MLA1055', name: 'Computación > Accesorios' },
    { id: 'MLM1000', name: 'Electrónica > Audio y Video' },
    { id: 'MLM1648', name: 'Celulares y Teléfonos' },
    { id: 'MLM1430', name: 'Ropa y Accesorios' },
    { id: 'MLM1132', name: 'Juegos y Juguetes' },
    { id: 'MLM1039', name: 'Cámaras y Accesorios' },
    { id: 'MLM1144', name: 'Consolas y Videojuegos' },
    { id: 'MLM1574', name: 'Hogar y Muebles' },
    { id: 'MLM1499', name: 'Industrias y Oficinas' },
    { id: 'MLM1276', name: 'Deportes y Fitness' },
  ];

  listingTypes = [
    { id: 'free', name: 'Gratuita', description: 'Publicación gratuita básica' },
    { id: 'bronze', name: 'Bronce', description: 'Mayor visibilidad' },
    { id: 'silver', name: 'Plata', description: 'Buena exposición' },
    { id: 'gold_special', name: 'Oro Especial', description: 'Alta exposición' },
    { id: 'gold_premium', name: 'Oro Premium', description: 'Máxima exposición' }
  ];

  warrantyTypes = [
    'Sin garantía',
    'Garantía del vendedor',
    'Garantía de fábrica'
  ];

  warrantyTimes = [
    '90 días',
    '6 meses',
    '1 año',
    '2 años'
  ];

  loading = false;
  successMessage = '';
  errorMessage = '';

  constructor(
    private http: HttpClient,
    private router: Router
  ) { }

  onSubmit(): void {
    this.loading = true;
    this.successMessage = '';
    this.errorMessage = '';

    // Prepare pictures array
    const pictures = this.product.pictures
      ? this.product.pictures.split('\n').filter(url => url.trim())
      : [];

    const productData = {
      ...this.product,
      pictures,
      price: parseFloat(this.product.price.toString()),
      available_quantity: parseInt(this.product.available_quantity.toString())
    };

    this.http.post(`${environment.apiUrl}/items`, productData).subscribe({
      next: (response: any) => {
        this.loading = false;
        this.successMessage = `¡Producto publicado exitosamente! ID: ${response.item.id}`;
        console.log('Product created:', response);

        // Reset form after 2 seconds
        setTimeout(() => {
          this.resetForm();
        }, 2000);
      },
      error: (error) => {
        this.loading = false;
        this.errorMessage = error.error?.message || 'Error al publicar el producto';
        console.error('Error creating product:', error);
      }
    });
  }

  resetForm(): void {
    this.product = {
      title: 'Cable USB-C Premium 2 metros',
      category_id: 'MLM1051',
      price: 199.99,
      available_quantity: 10,
      condition: 'new',
      pictures: '', // Dejar vacío por ahora para probar sin imágenes
      description: 'Cable USB-C de alta calidad con trenzado de nylon. Perfecto para carga rápida y transferencia de datos. Compatible con la mayoría de dispositivos móviles modernos.',
      listing_type_id: 'free',
      warranty_type: 'Garantía del vendedor',
      warranty_time: '6 meses'
    };
    this.successMessage = '';
    this.errorMessage = '';
  }
}
