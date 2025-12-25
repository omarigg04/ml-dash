import { Component, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from '../../environments/environment';
import { Router, ActivatedRoute } from '@angular/router';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ToastComponent } from '../shared/toast/toast.component';

// Interfaces para el producto
interface Attribute {
  id: string;
  name: string;
  value_id?: string | null;
  value_name: string;
  value_type: 'string' | 'list' | 'number' | 'number_unit';
  values?: Array<{
    id?: string | null;
    name: string;
    struct?: {
      number?: number;
      unit?: string;
    } | null;
  }>;
}

interface SaleTerm {
  id: string;
  value_name: string;
}

interface Picture {
  source: string;
}

interface Shipping {
  mode?: string;
  local_pick_up?: boolean;
  free_shipping?: boolean;
  logistic_type?: string;
  dimensions?: string | null;
}

interface Product {
  family_name: string;
  category_id: string;
  price: number;
  currency_id: string;
  available_quantity: number;
  buying_mode: string;
  condition: string;
  listing_type_id: string;
  sale_terms?: SaleTerm[];
  pictures?: Picture[];
  attributes?: Attribute[];
  shipping?: Shipping;
}

interface CategoryTemplate {
  id: string;
  name: string;
  description: string;
  defaultProduct: Product;
}

@Component({
  selector: 'app-publish-product',
  templateUrl: './publish-product.component.html',
  styleUrls: ['./publish-product.component.scss']
})
export class PublishProductComponent implements OnInit {

  // Producto actual (se inicializa con el template seleccionado)
  product: Product = {
    family_name: "Item de test No ofertar",
    category_id: "MLM187825",
    price: 350,
    currency_id: "MXN",
    available_quantity: 10,
    buying_mode: "buy_it_now",
    condition: "new",
    listing_type_id: "gold_special"
  };


  // Categoría seleccionada actualmente
  selectedCategoryId: string = 'MLM187825';

  // Templates de categorías predefinidas
  categoryTemplates: CategoryTemplate[] = [
    {
      id: 'MLM187825',
      name: 'Transistores',
      description: 'Componentes Electrónicos > Transistores',
      defaultProduct: {
        family_name: "Item de test No ofertar",
        category_id: "MLM187825",
        price: 350,
        currency_id: "MXN",
        available_quantity: 10,
        buying_mode: "buy_it_now",
        condition: "new",
        listing_type_id: "gold_special",
        sale_terms: [
          { id: "WARRANTY_TYPE", value_name: "Garantía del vendedor" },
          { id: "WARRANTY_TIME", value_name: "90 días" }
        ],
        pictures: [
          { source: "http://mla-s2-p.mlstatic.com/968521-MLA20805195516_072016-O.jpg" }
        ],
        attributes: [
          {
            id: "BRAND",
            name: "Marca",
            value_id: "276243",
            value_name: "Genérica",
            value_type: "string",
            values: [{ id: "276243", name: "Genérica", struct: null }]
          },
          {
            id: "EMPTY_GTIN_REASON",
            name: "Motivo de GTIN vacío",
            value_id: "17055160",
            value_name: "El producto no tiene código registrado",
            value_type: "list",
            values: [{ id: "17055160", name: "El producto no tiene código registrado", struct: null }]
          },
          {
            id: "ITEM_CONDITION",
            name: "Condición del ítem",
            value_id: "2230284",
            value_name: "Nuevo",
            value_type: "list",
            values: [{ id: "2230284", name: "Nuevo", struct: null }]
          },
          {
            id: "MODEL",
            name: "Modelo",
            value_id: "40492397",
            value_name: "NPN",
            value_type: "string",
            values: [{ id: "40492397", name: "NPN", struct: null }]
          },
          {
            id: "TRANSISTOR_CODE",
            name: "Código del transistor",
            value_id: "4786733",
            value_name: "2N3055",
            value_type: "string",
            values: [{ id: "4786733", name: "2N3055", struct: null }]
          }
        ],
        shipping: {
          mode: "me1",
          local_pick_up: false,
          free_shipping: true,
          logistic_type: "xd_drop_off"
        }
      }
    }
  ];

  listingTypes = [
    { id: 'free', name: 'Gratuita', description: 'Publicación gratuita básica' },
    { id: 'bronze', name: 'Bronce', description: 'Mayor visibilidad' },
    { id: 'silver', name: 'Plata', description: 'Buena exposición' },
    { id: 'gold_special', name: 'Oro Especial', description: 'Alta exposición' },
    { id: 'gold_premium', name: 'Oro Premium', description: 'Máxima exposición' }
  ];

  loading = false;
  successMessage = '';
  errorMessage = '';
  isDuplicateMode = false; // Track if we're in duplicate mode

  // Helper para formularios dinámicos
  picturesText: string = '';

  // Imágenes validadas del selector
  validatedPictureIds: Array<{ id: string }> = [];

  constructor(
    private http: HttpClient,
    private router: Router,
    private route: ActivatedRoute,
    private snackBar: MatSnackBar
  ) { }

  ngOnInit(): void {
    // Check if in duplicate mode
    this.route.queryParams.subscribe(params => {
      if (params['mode'] === 'duplicate') {
        this.loadDuplicateData();
      } else {
        // Cargar el template de la categoría inicial (Transistores)
        this.loadCategoryTemplate(this.selectedCategoryId);
      }
    });
  }

  /**
   * Load data from duplicated item
   */
  private loadDuplicateData(): void {
    const duplicateData = sessionStorage.getItem('duplicateItem');
    if (duplicateData) {
      const item = JSON.parse(duplicateData);

      // Set duplicate mode flag
      this.isDuplicateMode = true;

      console.log('📋 Duplicating item:', item);

      // Map pictures from ML format to form format
      // ML pictures have: {id, url, secure_url, size, ...}
      // Form expects: {source: "url"}
      let mappedPictures: Picture[] = [];
      if (item.pictures && Array.isArray(item.pictures)) {
        mappedPictures = item.pictures.map((pic: any) => ({
          source: pic.secure_url || pic.url || pic.source
        }));
      }

      // Ensure sale_terms has at least 2 elements (WARRANTY_TYPE and WARRANTY_TIME)
      let saleTerms: SaleTerm[] = [];
      if (item.sale_terms && Array.isArray(item.sale_terms) && item.sale_terms.length >= 2) {
        saleTerms = item.sale_terms;
      } else {
        // Initialize with default warranty terms
        saleTerms = [
          { id: "WARRANTY_TYPE", value_name: item.sale_terms?.[0]?.value_name || "Garantía del vendedor" },
          { id: "WARRANTY_TIME", value_name: item.sale_terms?.[1]?.value_name || "90 días" }
        ];
      }

      // Pre-fill form with item data
      this.product = {
        family_name: item.title + ' (Copia)',
        category_id: item.category_id,
        price: item.price,
        currency_id: item.currency_id || 'MXN',
        available_quantity: item.available_quantity,
        buying_mode: item.buying_mode || 'buy_it_now',
        condition: item.condition,
        listing_type_id: item.listing_type_id,
        sale_terms: saleTerms,
        pictures: mappedPictures,
        attributes: item.attributes || [],
        shipping: item.shipping || {}
      };

      // Update category selector
      this.selectedCategoryId = item.category_id;

      // Convert pictures to text for form display
      if (this.product.pictures && this.product.pictures.length > 0) {
        this.picturesText = this.product.pictures.map(p => p.source).join('\n');
      } else {
        this.picturesText = '';
      }

      // Clear sessionStorage
      sessionStorage.removeItem('duplicateItem');

      console.log('✅ Product form loaded with:', this.product);
      console.log('📸 Pictures text:', this.picturesText);
    } else {
      console.warn('⚠️ No duplicate data found in sessionStorage');
      // If no data found, load default template
      this.loadCategoryTemplate(this.selectedCategoryId);
    }
  }

  /**
   * Cambia la categoría y carga su template correspondiente
   */
  onCategoryChange(categoryId: string): void {
    // Don't reload template if we're in duplicate mode (to preserve duplicated data)
    if (this.isDuplicateMode) {
      console.log('🔒 In duplicate mode - category change ignored to preserve data');
      return;
    }

    this.selectedCategoryId = categoryId;
    this.loadCategoryTemplate(categoryId);
  }

  /**
   * Carga el template de una categoría específica
   */
  loadCategoryTemplate(categoryId: string): void {
    const template = this.categoryTemplates.find(t => t.id === categoryId);
    if (template) {
      // Deep clone para evitar referencias compartidas
      this.product = JSON.parse(JSON.stringify(template.defaultProduct));

      // Convertir pictures array a texto para el formulario
      if (this.product.pictures && this.product.pictures.length > 0) {
        this.picturesText = this.product.pictures.map(p => p.source).join('\n');
      } else {
        this.picturesText = '';
      }
    }
  }

  /**
   * Maneja las imágenes validadas del selector
   */
  handleImagesValidated(pictureIds: Array<{ id: string }>): void {
    console.log('[PublishProduct] Imágenes validadas recibidas:', pictureIds);
    this.validatedPictureIds = pictureIds;
  }

  onSubmit(): void {
    this.loading = true;
    this.successMessage = '';
    this.errorMessage = '';

    // Usar imágenes del selector si están disponibles, sino usar el textarea
    let pictures: Picture[] = [];

    if (this.validatedPictureIds.length > 0) {
      // Usar picture_ids validados del selector
      pictures = this.validatedPictureIds.map(pic => ({ source: pic.id }));
      console.log('[PublishProduct] Usando imágenes del selector:', pictures);
    } else if (this.picturesText) {
      // Fallback: usar URLs del textarea
      pictures = this.picturesText.split('\n')
        .filter(url => url.trim())
        .map(url => ({ source: url.trim() }));
      console.log('[PublishProduct] Usando imágenes del textarea:', pictures);
    }

    // Preparar el payload final
    const productData: Product = {
      ...this.product,
      pictures: pictures.length > 0 ? pictures : undefined
    };

    console.log('📦 Sending product data to API:', JSON.stringify(productData, null, 2));

    this.http.post(`${environment.apiUrl}/items`, productData).subscribe({
      next: (response: any) => {
        this.loading = false;
        const mode = this.isDuplicateMode ? 'duplicado' : 'nuevo';
        const message = `Producto ${mode} publicado exitosamente! ID: ${response.item.id}`;

        this.successMessage = message;

        // Show success toast with Flowbite style
        this.snackBar.openFromComponent(ToastComponent, {
          duration: 5000,
          horizontalPosition: 'end',
          verticalPosition: 'top',
          data: {
            message: message,
            type: 'success',
            action: {
              label: 'Ver',
              onClick: () => {
                window.open(response.item.permalink, '_blank');
              }
            }
          }
        });

        console.log('✅ Product created:', response);

        // Reset form after 2 seconds
        setTimeout(() => {
          this.resetForm();
        }, 2000);
      },
      error: (error) => {
        this.loading = false;
        const mode = this.isDuplicateMode ? 'duplicado' : 'nuevo';
        const errorMsg = error.error?.message || 'Error al publicar el producto';
        const message = `Error al publicar producto ${mode}: ${errorMsg}`;

        this.errorMessage = message;

        // Show error toast with Flowbite style
        this.snackBar.openFromComponent(ToastComponent, {
          duration: 7000,
          horizontalPosition: 'end',
          verticalPosition: 'top',
          data: {
            message: message,
            type: 'error'
          }
        });

        console.error('❌ Error creating product:', error);
        console.error('Error details:', error.error);
      }
    });
  }

  resetForm(): void {
    // Recargar el template de la categoría seleccionada
    this.loadCategoryTemplate(this.selectedCategoryId);
    this.successMessage = '';
    this.errorMessage = '';
  }

  /**
   * Añade un atributo dinámicamente
   */
  addAttribute(): void {
    if (!this.product.attributes) {
      this.product.attributes = [];
    }
    this.product.attributes.push({
      id: '',
      name: '',
      value_name: '',
      value_type: 'string'
    });
  }

  /**
   * Elimina un atributo
   */
  removeAttribute(index: number): void {
    if (this.product.attributes) {
      this.product.attributes.splice(index, 1);
    }
  }
}
