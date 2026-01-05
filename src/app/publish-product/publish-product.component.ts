import { Component, OnInit } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom, Subject } from 'rxjs';
import { debounceTime, distinctUntilChanged } from 'rxjs/operators';
import { environment } from '../../environments/environment';
import { Router, ActivatedRoute } from '@angular/router';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ToastComponent } from '../shared/toast/toast.component';
import { CategoryPredictorService, CategoryPrediction, CategoryAttribute } from '../services/category-predictor.service';

// Interfaces para el producto
interface Attribute {
  id: string;
  name: string;
  value_id?: string | null;
  value_name: string;
  value_type: 'string' | 'list' | 'number' | 'number_unit' | 'boolean';
  values?: Array<{
    id?: string | null;
    name?: string;
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
  description?: string; // Descripción del producto
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

  // Producto actual (se inicializa vacío para crear desde cero)
  product: Product = {
    family_name: "",
    category_id: "",
    price: 0,
    currency_id: "MXN",
    available_quantity: 1,
    buying_mode: "buy_it_now",
    condition: "new",
    listing_type_id: "gold_special"
  };


  // Categoría seleccionada actualmente
  selectedCategoryId: string = '';

  // Templates de categorías (ahora se llenan dinámicamente con el predictor)
  categoryTemplates: CategoryTemplate[] = [];

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
  originalItemImages: any[] = []; // Imágenes del item original (para modo duplicar)

  // Helper para formularios dinámicos
  picturesText: string = '';

  // Imágenes validadas del selector
  validatedPictureIds: Array<{ id: string; url?: string }> = [];

  // Predictor de categorías
  categoryPredictions: CategoryPrediction[] = [];
  isLoadingPredictions = false;
  showCategoryPredictions = false;
  private productNameSubject = new Subject<string>();

  // Atributos dinámicos de categoría
  categoryAttributes: CategoryAttribute[] = [];
  isLoadingAttributes = false;
  attributeValues: { [key: string]: any } = {};
  attributeErrors: { [key: string]: string } = {}; // Errores de validación por atributo

  constructor(
    private http: HttpClient,
    private router: Router,
    private route: ActivatedRoute,
    private snackBar: MatSnackBar,
    private categoryPredictor: CategoryPredictorService
  ) { }

  ngOnInit(): void {
    // Setup category predictor with debounce
    this.productNameSubject.pipe(
      debounceTime(800), // Wait 800ms after user stops typing
      distinctUntilChanged()
    ).subscribe(productName => {
      if (productName && productName.trim().length >= 3) {
        this.predictCategory(productName);
      } else {
        this.categoryPredictions = [];
        this.showCategoryPredictions = false;
      }
    });

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
  private async loadDuplicateData(): Promise<void> {
    const duplicateData = sessionStorage.getItem('duplicateItem');
    if (duplicateData) {
      const item = JSON.parse(duplicateData);

      // Set duplicate mode flag
      this.isDuplicateMode = true;

      console.log('📋 Duplicating item:', item);

      // Guardar imágenes originales completas para pasar al selector
      this.originalItemImages = item.pictures || [];
      console.log('📸 Original images:', this.originalItemImages);

      // Fetch description from API (separate endpoint)
      let description = '';
      try {
        console.log('📄 Fetching description for item:', item.id);
        const descResponse = await firstValueFrom(
          this.http.get<any>(`${environment.apiUrl}/items/${item.id}/description`)
        );
        description = descResponse?.plain_text || '';
        console.log('✅ Description fetched:', description ? `${description.substring(0, 100)}...` : '(empty)');
      } catch (error) {
        console.warn('⚠️ Could not fetch description:', error);
        description = '';
      }

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
        description: description, // Usar descripción obtenida del endpoint
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

      // Cargar atributos dinámicos de la categoría y pre-llenar con valores del item duplicado
      // Esto implementa la "Opción Híbrida" del plan de atributos dinámicos
      console.log('🔄 Loading dynamic attributes for duplicated item category:', item.category_id);
      this.loadCategoryAttributes(item.category_id);
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
  handleImagesValidated(pictureIds: Array<{ id: string; url?: string }>): void {
    console.log('[PublishProduct] Imágenes validadas recibidas:', pictureIds);
    this.validatedPictureIds = pictureIds;
  }

  /**
   * Valida todos los atributos antes de enviar
   * @returns true si todos los atributos son válidos, false si hay errores
   */
  private validateAttributes(): boolean {
    this.attributeErrors = {}; // Limpiar errores previos
    let isValid = true;

    console.log('[PublishProduct] Validating attributes...');

    // Validar cada atributo de la categoría
    this.categoryAttributes.forEach(catAttr => {
      const isRequired = catAttr.tags.required || catAttr.tags.catalog_required;

      // Validación de campos requeridos
      if (isRequired) {
        let hasValue = false;

        // Para number_unit, verificar ambos campos
        if (catAttr.value_type === 'number_unit') {
          const numberValue = this.attributeValues[catAttr.id + '_number'];
          const unitValue = this.attributeValues[catAttr.id + '_unit'];
          hasValue = numberValue !== undefined && numberValue !== null && numberValue !== '' &&
                     unitValue !== undefined && unitValue !== null && unitValue !== '';

          if (!hasValue) {
            this.attributeErrors[catAttr.id] = 'Este campo es requerido';
            isValid = false;
          }
        } else {
          // Para otros tipos, verificar el valor directo
          const value = this.attributeValues[catAttr.id];
          hasValue = value !== undefined && value !== null && value !== '';

          if (!hasValue) {
            this.attributeErrors[catAttr.id] = 'Este campo es requerido';
            isValid = false;
          }
        }
      }

      // Validación por tipo de dato
      const value = this.attributeValues[catAttr.id];
      if (value !== undefined && value !== null && value !== '') {
        switch (catAttr.value_type) {
          case 'string':
            // Validar longitud máxima
            if (catAttr.value_max_length && String(value).length > catAttr.value_max_length) {
              this.attributeErrors[catAttr.id] = `Máximo ${catAttr.value_max_length} caracteres`;
              isValid = false;
            }
            break;

          case 'number':
            // Validar que sea un número válido
            if (isNaN(Number(value))) {
              this.attributeErrors[catAttr.id] = 'Debe ser un número válido';
              isValid = false;
            }
            break;

          case 'number_unit':
            // Validar que el número sea válido
            const numberValue = this.attributeValues[catAttr.id + '_number'];
            if (numberValue !== undefined && numberValue !== null && numberValue !== '' && isNaN(Number(numberValue))) {
              this.attributeErrors[catAttr.id] = 'El valor numérico debe ser válido';
              isValid = false;
            }
            break;

          case 'list':
            // Validar que el valor esté en la lista de opciones
            if (catAttr.values && catAttr.values.length > 0) {
              const validOption = catAttr.values.find(v => v.id === value);
              if (!validOption) {
                this.attributeErrors[catAttr.id] = 'Seleccione una opción válida';
                isValid = false;
              }
            }
            break;

          case 'boolean':
            // Boolean siempre es válido (true/false)
            break;
        }
      }
    });

    if (!isValid) {
      console.log('[PublishProduct] Validation failed. Errors:', this.attributeErrors);
    } else {
      console.log('[PublishProduct] All attributes are valid');
    }

    return isValid;
  }

  /**
   * Construye el array de attributes desde attributeValues (atributos dinámicos)
   */
  private buildAttributesFromValues(): void {
    const attributes: Attribute[] = [];

    console.log('[PublishProduct] Building attributes from values...');
    console.log('  - Category attributes:', this.categoryAttributes.length);
    console.log('  - Attribute values:', this.attributeValues);

    // Iterar sobre los atributos de la categoría y construir el array
    this.categoryAttributes.forEach(catAttr => {
      const value = this.attributeValues[catAttr.id];

      // Solo incluir atributos con valor
      if (value === undefined || value === null || value === '') {
        return; // Skip este atributo
      }

      // Construir objeto de atributo según el tipo
      switch (catAttr.value_type) {
        case 'string':
        case 'number':
          attributes.push({
            id: catAttr.id,
            name: catAttr.name,
            value_name: String(value),
            value_type: catAttr.value_type
          });
          break;

        case 'list':
          // Para list, necesitamos encontrar el value_id y value_name
          const selectedOption = catAttr.values?.find(v => v.id === value);
          if (selectedOption) {
            attributes.push({
              id: catAttr.id,
              name: catAttr.name,
              value_id: selectedOption.id,
              value_name: selectedOption.name,
              value_type: 'list'
            });
          }
          break;

        case 'number_unit':
          // Para number_unit, necesitamos combinar el número y la unidad
          const numberValue = this.attributeValues[catAttr.id + '_number'];
          const unitValue = this.attributeValues[catAttr.id + '_unit'];

          if (numberValue && unitValue) {
            attributes.push({
              id: catAttr.id,
              name: catAttr.name,
              value_name: `${numberValue} ${unitValue}`,
              value_type: 'number_unit',
              values: [{
                name: `${numberValue} ${unitValue}`,
                struct: {
                  number: Number(numberValue),
                  unit: unitValue
                }
              }]
            });
          }
          break;

        case 'boolean':
          // Para boolean, usar el valor como value_name
          const boolValue = value ? 'Sí' : 'No';
          const boolOption = catAttr.values?.find(v => v.metadata?.value === value);

          attributes.push({
            id: catAttr.id,
            name: catAttr.name,
            value_id: boolOption?.id,
            value_name: boolOption?.name || boolValue,
            value_type: 'boolean'
          });
          break;
      }
    });

    console.log(`[PublishProduct] Built ${attributes.length} attributes from dynamic values`);
    console.log('  - Attributes:', JSON.stringify(attributes, null, 2));

    // Asignar al producto
    this.product.attributes = attributes;
  }

  onSubmit(): void {
    this.loading = true;
    this.successMessage = '';
    this.errorMessage = '';

    // Validar atributos antes de continuar
    if (!this.validateAttributes()) {
      this.loading = false;
      this.errorMessage = 'Por favor completa todos los campos requeridos correctamente';

      this.snackBar.openFromComponent(ToastComponent, {
        duration: 5000,
        horizontalPosition: 'end',
        verticalPosition: 'top',
        data: {
          message: 'Por favor completa todos los campos requeridos correctamente',
          type: 'error'
        }
      });

      console.log('[PublishProduct] Form validation failed - blocking submission');
      return;
    }

    // Construir array de attributes desde attributeValues (atributos dinámicos)
    this.buildAttributesFromValues();

    // Usar imágenes del selector si están disponibles, sino usar el textarea
    let pictures: Picture[] = [];

    if (this.validatedPictureIds.length > 0) {
      // Usar URLs validadas del selector
      // ML requiere { source: "url" } según documentación
      pictures = this.validatedPictureIds
        .filter(pic => pic.url) // Solo las que tienen URL
        .map(pic => ({ source: pic.url! }));

      console.log('[PublishProduct] Usando imágenes del selector (URLs):', pictures);

      if (pictures.length === 0) {
        console.warn('[PublishProduct] ⚠️ No se encontraron URLs en las imágenes validadas');
      }
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

  /**
   * Maneja cambios en el nombre del producto para predecir categoría
   */
  onProductNameChange(value: string): void {
    this.productNameSubject.next(value);
  }

  /**
   * Predice la categoría basándose en el nombre del producto
   */
  predictCategory(productName: string): void {
    if (!productName || productName.trim().length < 3) {
      return;
    }

    this.isLoadingPredictions = true;
    console.log('[PublishProduct] Predicting category for:', productName);

    this.categoryPredictor.predictCategory(productName, 3).subscribe({
      next: (response) => {
        this.categoryPredictions = response.predictions;
        this.showCategoryPredictions = response.predictions.length > 0;
        this.isLoadingPredictions = false;

        console.log('[PublishProduct] Category predictions:', this.categoryPredictions);
      },
      error: (error) => {
        console.error('[PublishProduct] Error predicting category:', error);
        this.categoryPredictions = [];
        this.showCategoryPredictions = false;
        this.isLoadingPredictions = false;
      }
    });
  }

  /**
   * Selecciona una categoría predicha
   */
  selectPredictedCategory(prediction: CategoryPrediction): void {
    console.log('[PublishProduct] Selected category:', prediction);

    // Verificar si la categoría ya existe en categoryTemplates
    const existingTemplate = this.categoryTemplates.find(t => t.id === prediction.category_id);

    if (!existingTemplate) {
      // Agregar la categoría predicha al dropdown
      this.categoryTemplates.push({
        id: prediction.category_id,
        name: prediction.category_name,
        description: prediction.domain_name,
        defaultProduct: {
          family_name: '',
          category_id: prediction.category_id,
          price: 0,
          currency_id: 'MXN',
          available_quantity: 1,
          buying_mode: 'buy_it_now',
          condition: 'new',
          listing_type_id: 'gold_special'
        }
      });

      console.log('[PublishProduct] Added predicted category to templates:', prediction.category_name);
    }

    // Actualizar el category_id del producto
    this.product.category_id = prediction.category_id;
    this.selectedCategoryId = prediction.category_id;

    // Ocultar las predicciones
    this.showCategoryPredictions = false;

    // Mostrar mensaje de confirmación
    this.snackBar.openFromComponent(ToastComponent, {
      duration: 3000,
      horizontalPosition: 'end',
      verticalPosition: 'top',
      data: {
        message: `Categoría seleccionada: ${prediction.category_name}`,
        type: 'success'
      }
    });

    // Cargar atributos de la categoría seleccionada
    this.loadCategoryAttributes(prediction.category_id);
  }

  /**
   * Carga los atributos dinámicos de una categoría
   */
  loadCategoryAttributes(categoryId: string): void {
    console.log('[PublishProduct] Loading attributes for category:', categoryId);

    this.isLoadingAttributes = true;

    this.categoryPredictor.getCategoryAttributes(categoryId).subscribe({
      next: (attributes) => {
        console.log(`[PublishProduct] Loaded ${attributes.length} attributes`);

        // Filtrar atributos ocultos y de solo lectura
        this.categoryAttributes = attributes.filter(attr =>
          !attr.tags.hidden && !attr.tags.read_only
        );

        // Ordenar: requeridos primero, luego por relevancia
        this.categoryAttributes.sort((a, b) => {
          const aRequired = a.tags.required || a.tags.catalog_required;
          const bRequired = b.tags.required || b.tags.catalog_required;

          if (aRequired && !bRequired) return -1;
          if (!aRequired && bRequired) return 1;

          return b.relevance - a.relevance;
        });

        console.log(`[PublishProduct] Showing ${this.categoryAttributes.length} attributes after filtering`);

        // Pre-llenar attributeValues con valores existentes del producto
        if (this.product.attributes && this.product.attributes.length > 0) {
          this.product.attributes.forEach(attr => {
            this.attributeValues[attr.id] = attr.value_name;
          });
        }

        this.isLoadingAttributes = false;
      },
      error: (error) => {
        console.error('[PublishProduct] Error loading attributes:', error);
        this.isLoadingAttributes = false;

        this.snackBar.openFromComponent(ToastComponent, {
          duration: 4000,
          horizontalPosition: 'end',
          verticalPosition: 'top',
          data: {
            message: 'Error al cargar atributos de la categoría',
            type: 'error'
          }
        });
      }
    });
  }

  /**
   * Cierra el panel de predicciones
   */
  closeCategoryPredictions(): void {
    this.showCategoryPredictions = false;
  }
}
