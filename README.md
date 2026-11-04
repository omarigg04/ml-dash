# MercadoLibre Dashboard

Panel para administrar tiendas de Mercado Libre México: ventas, órdenes, publicaciones, analítica y sugerencias con IA. Una misma app atiende a varias cuentas de vendedor; cada una entra con su propio login de Mercado Libre.

La fuente de los datos de negocio es la API de Mercado Libre. **La app no tiene base de datos:** consulta a ML en cada petición y solo guarda tokens y resultados de IA en un almacén clave-valor. Ver [Dónde se guarda cada dato](#dónde-se-guarda-cada-dato).

## Funciones

| Pantalla | Ruta | Qué hace |
|---|---|---|
| Inicio | `/inicio` | Resumen: KPIs, más vendidos, pendientes y CSV |
| Analytics | `/analytics` | Gráficas, conversión (órdenes ÷ visitas de la misma ventana) y tips |
| Oportunidades | `/oportunidades` | Publicaciones con visitas y pocas ventas, sugerencias de IA, ideas nuevas y seguimiento de cambios |
| Órdenes | `/orders` | Tabla y desglose de cada orden (comisión, envío y retenciones SAT) |
| Publicaciones | `/publications` | Tabla con filtros, orden por columna, editar, pausar y acciones en lote |
| Cargas masivas | `/publications/cargas-masivas` | Varias copias de una publicación, con títulos propuestos por IA |
| Publicar | `/publish` | Crear o duplicar una publicación |
| Galería | `/gallery` | Imágenes subidas a ML y catálogo |
| Configuración | `/settings` | Autorización de la cuenta y tema |

## Tecnologías

| Capa | Qué se usa |
|---|---|
| Frontend | Angular 16, Angular Material 16, SCSS, RxJS |
| Tablas y gráficas | ag-grid 31 (solo Órdenes), ag-charts 9 |
| Backend | Node 22, Express 4, TypeScript, axios, multer, zod |
| Hosting | Vercel: sitio estático y una sola función serverless |
| Almacenamiento | KV por API REST, compatible con Redis (`KV_REST_API_*`) |
| IA | Google Gemini en plan gratuito (`@google/genai`). Anthropic es opcional y de pago |
| Integración | API de Mercado Libre con OAuth 2 y PKCE |
| Pruebas | `node:test` con ML y KV simulados |
| CI | GitHub Actions: build, revisión de tipos y pruebas. Dependabot para dependencias |

## Arquitectura

```text
Navegador (Angular)
   │  mismo origen, cookie de sesión firmada
   ▼
Vercel
   ├─ /*      → dist/ml-dash (sitio estático)
   └─ /api/*  → api/index.ts (Express, 1024 MB, máx. 60 s por petición)
                 ├─ API de Mercado Libre  → datos de negocio
                 ├─ KV por REST           → tokens y resultados de IA
                 └─ Google Gemini         → sugerencias
```

- **Backend:** el punto de entrada es [api/index.ts](api/index.ts) y las rutas están en [backend/src/routes/](backend/src/routes/).
- **Multicuenta:** la sesión lleva el ID de la cuenta, y `AsyncLocalStorage` lo pasa a tokens y cachés. Sin cuenta en contexto, la petición falla con 401. Ver [context.ts](backend/src/auth/context.ts).
- **Acceso:** solo entran los IDs de `ALLOWED_ML_USER_ID`.
- **Sesión:** cookie firmada con HMAC que dura 30 días y no se guarda en el servidor.
- **Sin procesos programados:** no hay cron ni tareas en segundo plano. Solo se trabaja cuando alguien abre la app.

## Dónde se guarda cada dato

### KV (persistente)

Todas las claves incluyen el ID de la cuenta.

| Clave | Contenido | Caducidad |
|---|---|---|
| `meli_oauth_token_v2:<uid>` | Token de ML de cada cuenta | Sin caducidad |
| `meli_oauth_token_v2` | Token anterior a multicuenta; se conserva por compatibilidad | Sin caducidad |
| `ai_suggest:<uid>:<item>` | Última sugerencia de IA por publicación | 7 días |
| `ai_ideas:<uid>` | Últimas ideas de publicaciones | 7 días |
| `ai_usage:<uid>:<día>` | Contador diario de IA | 2 días |
| `ai_change:<uid>:<item>:<ts>` | Cambio aplicado: antes, después y línea base de 30 días | Sin caducidad |
| `ai_change_idx:<uid>` | Índice de cambios, máximo 100 | Sin caducidad |

### Memoria de la función (se pierde al reiniciarse)

| Dato | Duración |
|---|---|
| Lista de publicaciones | 5 min |
| Visitas diarias | 10 min |
| Respuestas de resumen y analítica | 30 s |
| Envíos | 2 min, o 6 h si ya terminaron |

### Navegador (solo en ese equipo)

`localStorage` guarda el tema, los filtros, los borradores de Publicar y Cargas masivas, la galería de imágenes y una caché de respuestas de la API. `sessionStorage` guarda la cola de duplicados. Las órdenes se quedan solo en memoria.

### Sin guardar

Solo existen en Mercado Libre:

- Visitas diarias
- Órdenes y ventas
- Costos de envío
- Historial de precio, stock y estado de cada publicación

## Límites que afectan al historial

| Límite | Valor | Definido en |
|---|---|---|
| Visitas consultables hacia atrás | 150 días | `MAX_WINDOW_DAYS`, [analytics.ts](backend/src/routes/analytics.ts) |
| Publicaciones con consulta de visitas | 250 | `MAX_ITEMS`, [analytics.ts](backend/src/routes/analytics.ts) |
| Rango del resumen | 92 días | `MAX_RANGE_DAYS`, [summary.ts](backend/src/routes/summary.ts) |
| Duración por petición | 60 s | [vercel.json](vercel.json) |
| Generaciones de IA por cuenta al día | 20 (`AI_DAILY_LIMIT`) | [opportunities.ts](backend/src/routes/opportunities.ts) |
| Tamaño de imagen al subir | 4 MB | [images.ts](backend/src/routes/images.ts) |

`sold_quantity` de ML es un total histórico, así que no sirve para calcular la conversión de un periodo.

## Si se agrega una base de datos

Condiciones que ya impone la app:

- **Aislamiento:** cada fila debe llevar el ID de la cuenta, tomado de la sesión y nunca del cliente.
- **Conexiones:** corre en funciones serverless, así que necesita pooling o un driver HTTP.
- **Tokens:** pueden quedarse en el KV. Una base nueva no tiene que reemplazarlo por completo.
- **Compradores:** las respuestas de órdenes de ML traen datos personales. Guardar solo lo necesario.
- **Captura:** hoy no hay cron. Para guardar historial hay que crear uno y volver a capturar sin duplicar filas.

## Desarrollo local

CI usa Node 22. La API lee `backend/.env`.

```bash
npm install
npm --prefix backend install
cp .env.example backend/.env
```

`.env.example` no trae todas las variables: completa con la [tabla de abajo](#variables-de-entorno).

En dos terminales, desde la raíz:

```bash
npm run dev:vercel   # API en http://127.0.0.1:3000
npm start            # App en http://127.0.0.1:4200
```

El login de ML no funciona en local. Para trabajar sin él, usa `LOCAL_DEV_NO_AUTH=true`, que se ignora en producción.

## Variables de entorno

Se configuran en `.env` en local y en el panel de Vercel en producción. Nunca se suben al repositorio.

| Variable | Uso | Requerida |
|---|---|---|
| `APP_ID`, `APP_SECRET`, `REDIRECT_URI` | Aplicación de Mercado Libre | Sí |
| `SESSION_SECRET` | Firma de la cookie de sesión | Sí |
| `ALLOWED_ML_USER_ID` | Cuentas permitidas, separadas por comas | Sí |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Almacén KV | En producción |
| `GEMINI_API_KEY` | Funciones de IA | Para usar IA |
| `GEMINI_MODEL`, `AI_PROVIDER`, `AI_DAILY_LIMIT` | Ajustes de IA | No |
| `ANTHROPIC_API_KEY` | Solo con `AI_PROVIDER=anthropic` (de pago) | No |
| `FRONTEND_URL` | Orígenes extra; no hace falta con el mismo dominio | No |
| `SESSION_VERSION` | Subirla cierra todas las sesiones | No |
| `LOCAL_DEV_NO_AUTH`, `LOCAL_DEV_UID`, `PORT` | Solo desarrollo local | No |

## Pruebas y build

```bash
npm --prefix backend test   # ML y KV simulados, sin red
npm run build               # Build de producción en dist/ml-dash
```

CI corre el build, la revisión de tipos y las pruebas del backend en cada PR. Vercel despliega al fusionar en `main`.
