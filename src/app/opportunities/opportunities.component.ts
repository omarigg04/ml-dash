import { Component, OnInit } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { environment } from '../../environments/environment';

type LoadState = 'loading' | 'ready' | 'error';
type PanelState = 'idle' | 'loading' | 'ready' | 'error';

export interface Usage { used: number; limit: number; remaining: number; }
export interface Candidate {
  id: string; title: string; price: number; listing_type_id: string; permalink: string;
  visits: number; orders: number; units: number; conversionPct: number;
}
export interface BestSeller { id: string; title: string; orders: number; units: number; visits: number | null; }
export interface CandidatesResponse {
  window: { days: number; from: string; to: string };
  thresholds: { minVisits: number; maxConversionPct: number };
  improve: Candidate[]; bestSellers: BestSeller[];
  partial: boolean; ordersTruncated: boolean;
  ai: { configured: boolean; usage: Usage | null };
}
export interface Suggestion {
  itemId: string; generatedAt: string; cached: boolean;
  metrics: { windowDays: number; visits: number; orders: number; units: number; conversionPct: number };
  current: { title: string; description: string; price: number | null };
  titleLock: string | null;
  titles: { title: string; reason: string; length: number }[];
  droppedTitles: number;
  description: { text: string; reason: string; flags: { code: string; text: string }[] };
  checks: string[]; warnings: string[];
  usage: Usage;
}
export interface Idea {
  title: string; kind: string; source_item_id: string; source_title: string;
  data_behind: string; confirm_stock: string[]; length: number;
}
export interface IdeasResponse {
  generatedAt: string; cached: boolean; window: { days: number };
  ideas: Idea[]; warnings: string[]; usage: Usage;
}
export interface ChangeSide { days: number; visits: number; orders: number; visitsPerDay: number; ordersPerDay: number; conversionPct: number; }
export interface AppliedChange {
  itemId: string; field: 'title' | 'description'; textBefore: string; textAfter: string;
  appliedAt: string; appliedDay: string; verified: boolean;
  daysElapsed: number; afterDays: number;
  status: 'insufficient' | 'ready' | 'unavailable'; reason: string;
  before: ChangeSide | null; after: ChangeSide | null;
}
export interface AppliedResponse { changes: AppliedChange[]; minDays: number; minVisits: number; note: string; }

interface ApiError { code: string; message: string; }

/** Mismas comprobaciones que el servidor para el texto editable de la descripción (el servidor es la fuente de verdad). */
export function descriptionProblems(text: string): string[] {
  const out: string[] = [];
  if (!text.trim()) out.push('La descripción está vacía.');
  if (/(https?:\/\/|www\.)\S+/i.test(text) || /\b[a-z0-9-]+\.(com|mx|net|org|io|co|app|shop|store)\b/i.test(text)) out.push('Tiene enlaces o direcciones web.');
  if (/<\/?[a-z][^>]*>|&[a-z]+;|&#\d+;/i.test(text)) out.push('Tiene HTML; usa solo texto plano.');
  if (/(\+?\d[\s().-]?){10,}/.test(text.replace(/\$\s?[\d.,]+/g, ''))) out.push('Parece tener un teléfono.');
  if (/[^\s@]+@[^\s@]+\.[a-z]{2,}/i.test(text)) out.push('Tiene un correo.');
  if (/\b(whats\s?app|wasap|telegram|facebook|instagram|messenger)\b/i.test(text)) out.push('Menciona un canal de contacto externo.');
  if (text.length > 50000) out.push('Es demasiado larga.');
  return out;
}

@Component({
  selector: 'app-opportunities',
  templateUrl: './opportunities.component.html',
  styleUrls: ['./opportunities.component.scss']
})
export class OpportunitiesComponent implements OnInit {
  private api = environment.apiUrl + '/opportunities';

  // ---- Candidatas ----
  state: LoadState = 'loading';
  data: CandidatesResponse | null = null;
  loadError = '';
  usage: Usage | null = null;
  aiConfigured = true;

  // ---- Panel de sugerencias ----
  selected: Candidate | null = null;
  panel: PanelState = 'idle';
  panelError: ApiError | null = null;
  suggestion: Suggestion | null = null;
  copied = '';
  titleConfirm = '';
  titleApplying = '';
  titleNotice: Record<string, string> = {};
  titleError: Record<string, string> = {};
  descDraft = '';
  descStep: 'edit' | 'review' = 'edit';
  descSaving = false;
  descError = '';
  descDone = '';

  // ---- Ideas ----
  ideasState: PanelState = 'idle';
  ideasError: ApiError | null = null;
  ideas: IdeasResponse | null = null;

  // ---- Cambios y resultados ----
  changesState: LoadState = 'loading';
  changes: AppliedResponse | null = null;

  constructor(private http: HttpClient, private router: Router) {}

  ngOnInit(): void {
    this.loadCandidates();
    this.loadChanges();
  }

  // ---------------- Carga ----------------
  loadCandidates(): void {
    this.state = 'loading';
    this.http.get<CandidatesResponse>(`${this.api}/candidates`).subscribe({
      next: d => {
        this.data = d;
        this.aiConfigured = d.ai.configured;
        this.usage = d.ai.usage;
        this.state = 'ready';
      },
      error: (e: HttpErrorResponse) => {
        this.loadError = e.error?.error || 'No pudimos leer tus publicaciones desde Mercado Libre.';
        this.state = 'error';
      }
    });
  }

  loadChanges(): void {
    this.changesState = 'loading';
    this.http.get<AppliedResponse>(`${this.api}/applied`).subscribe({
      next: d => { this.changes = d; this.changesState = 'ready'; },
      error: () => { this.changesState = 'error'; }
    });
  }

  private toApiError(e: HttpErrorResponse): ApiError {
    const code = e.error?.code || (e.status === 0 ? 'NETWORK' : 'ERROR');
    if (code === 'AI_NOT_CONFIGURED') this.aiConfigured = false;
    if (code === 'AI_DAILY_LIMIT' && this.usage) this.usage = { ...this.usage, used: this.usage.limit, remaining: 0 };
    return { code, message: e.error?.error || (e.status === 0 ? 'No hay conexión con el servidor.' : 'No se pudo completar la operación.') };
  }

  get limitReached(): boolean { return !!this.usage && this.usage.remaining <= 0; }
  get aiDisabled(): boolean { return !this.aiConfigured; }

  // ---------------- Sugerir mejoras ----------------
  openSuggest(c: Candidate, regenerate = false): void {
    if (this.aiDisabled) return;
    if (this.selected?.id !== c.id) this.resetPanelResults();
    this.selected = c;
    this.panel = 'loading';
    this.panelError = null;
    this.http.post<Suggestion>(`${this.api}/suggest`, { itemId: c.id, regenerate }).subscribe({
      next: s => {
        if (this.selected?.id !== c.id) return;
        this.suggestion = s;
        this.usage = s.usage;
        this.descDraft = s.description.text;
        this.descStep = 'edit';
        this.descError = '';
        this.descDone = '';
        this.panel = 'ready';
      },
      error: (e: HttpErrorResponse) => {
        if (this.selected?.id !== c.id) return;
        this.panelError = this.toApiError(e);
        this.panel = 'error';
      }
    });
  }

  regenerate(): void {
    if (this.selected && this.panel !== 'loading') this.openSuggest(this.selected, true);
  }

  closePanel(): void {
    if (this.descSaving || this.titleApplying) return;
    this.selected = null;
    this.panel = 'idle';
    this.resetPanelResults();
  }

  private resetPanelResults(): void {
    this.suggestion = null;
    this.panelError = null;
    this.titleNotice = {};
    this.titleError = {};
    this.titleConfirm = '';
    this.titleApplying = '';
    this.copied = '';
    this.descDraft = '';
    this.descStep = 'edit';
    this.descError = '';
    this.descDone = '';
  }

  // ---------------- Títulos: copiar y aplicar ----------------
  async copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } finally { document.body.removeChild(ta); }
    }
    this.copied = text;
    setTimeout(() => { if (this.copied === text) this.copied = ''; }, 2000);
  }

  askApplyTitle(title: string): void {
    if (this.titleApplying || this.suggestion?.titleLock) return;
    delete this.titleError[title];
    this.titleConfirm = title;
  }

  cancelApplyTitle(): void { if (!this.titleApplying) this.titleConfirm = ''; }

  /** Cambia el título en Mercado Libre. El servidor vuelve a comprobar las ventas con el item fresco. */
  async confirmApplyTitle(title: string): Promise<void> {
    const s = this.suggestion;
    if (!s || this.titleApplying || s.titleLock) return;
    const before = s.current.title;
    this.titleApplying = title;
    let shown = '';
    try {
      const r: any = await firstValueFrom(this.http.put(`${environment.apiUrl}/items/${encodeURIComponent(s.itemId)}`, { title }));
      shown = String(r?.updated?.title ?? '');
    } catch (e) {
      const err = e as HttpErrorResponse;
      const causes: string[] = (err.error?.causes || []).map((c: any) => c.message || c.code).filter(Boolean);
      const message = causes.join(' ') || err.error?.error || 'No se pudo guardar en Mercado Libre.';
      if (err.error?.causes?.some((c: any) => c.code === 'field_locked')) { s.titleLock = message; s.titles = []; }
      else this.titleError[title] = message;
      this.titleConfirm = '';
      this.titleApplying = '';
      return;
    }
    const verified = shown === title;
    let notice = verified
      ? 'Título cambiado en Mercado Libre y registrado en «Cambios y resultados».'
      : 'Mercado Libre aceptó el cambio, pero todavía muestra otro título. Revísalo en un momento.';
    if (verified) {
      s.current.title = title;
      if (this.selected) this.selected.title = title;
    }
    try {
      await firstValueFrom(this.http.post(`${this.api}/applied`, { itemId: s.itemId, field: 'title', before, after: title }));
    } catch (e) {
      notice = (verified ? 'Título cambiado en Mercado Libre' : 'Mercado Libre aceptó el cambio') + ', pero no se pudo registrar el seguimiento: ' + this.toApiError(e as HttpErrorResponse).message;
    }
    this.titleNotice = { [title]: notice };
    this.titleConfirm = '';
    this.titleApplying = '';
    this.loadChanges();
  }

  // ---------------- Descripción: revisar, guardar vía PUT /api/items/:id y registrar ----------------
  get descProblems(): string[] { return descriptionProblems(this.descDraft); }
  get descChanged(): boolean { return !!this.suggestion && this.descDraft !== this.suggestion.current.description; }

  reviewDescription(): void {
    if (this.descProblems.length || !this.descChanged) return;
    this.descError = '';
    this.descStep = 'review';
  }

  backToEdit(): void { if (!this.descSaving) this.descStep = 'edit'; }

  async confirmDescription(): Promise<void> {
    const s = this.suggestion;
    if (!s || this.descSaving || this.descProblems.length) return;
    this.descSaving = true;
    this.descError = '';
    try {
      // Mismo endpoint y reglas que el panel Editar de Publicaciones; solo se envía si el humano confirma
      await firstValueFrom(this.http.put(`${environment.apiUrl}/items/${encodeURIComponent(s.itemId)}`, { description: this.descDraft }));
    } catch (e) {
      const err = e as HttpErrorResponse;
      const causes: string[] = (err.error?.causes || []).map((c: any) => c.message || c.code).filter(Boolean);
      this.descError = err.status === 207
        ? 'La descripción no se pudo guardar: ' + (err.error?.description?.error || 'error de Mercado Libre')
        : (causes.join(' ') || err.error?.error || 'No se pudo guardar en Mercado Libre.');
      this.descStep = 'edit';
      this.descSaving = false;
      return;
    }
    try {
      await firstValueFrom(this.http.post(`${this.api}/applied`, { itemId: s.itemId, field: 'description', before: s.current.description, after: this.descDraft }));
      this.descDone = 'Descripción guardada en Mercado Libre y registrada en «Cambios y resultados».';
    } catch (e) {
      this.descDone = 'Descripción guardada en Mercado Libre, pero no se pudo registrar el seguimiento: ' + this.toApiError(e as HttpErrorResponse).message;
    }
    s.current.description = this.descDraft;
    this.descStep = 'edit';
    this.descSaving = false;
    this.loadChanges();
  }

  // ---------------- Ideas ----------------
  generateIdeas(regenerate = false): void {
    if (this.aiDisabled || this.ideasState === 'loading') return;
    this.ideasState = 'loading';
    this.ideasError = null;
    this.http.post<IdeasResponse>(`${this.api}/ideas`, { regenerate }).subscribe({
      next: r => { this.ideas = r; this.usage = r.usage; this.ideasState = 'ready'; },
      error: (e: HttpErrorResponse) => { this.ideasError = this.toApiError(e); this.ideasState = 'error'; }
    });
  }

  /** Abre el formulario de duplicar con el nombre sugerido ya escrito. No publica nada. */
  createFromIdea(i: Idea): void {
    this.router.navigate(['/publish'], { queryParams: { mode: 'duplicate', from: i.source_item_id, name: i.title } });
  }

  // ---------------- Presentación ----------------
  pct(n: number | null | undefined): string { return n == null ? '—' : n.toLocaleString('es-MX', { maximumFractionDigits: 2 }) + '%'; }
  num(n: number | null | undefined, d = 0): string { return n == null ? '—' : n.toLocaleString('es-MX', { maximumFractionDigits: d }); }
  money(n: number | null | undefined): string { return n == null ? '—' : n.toLocaleString('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }); }
  fieldLabel(f: string): string { return f === 'title' ? 'Título' : 'Descripción'; }
  kindLabel(k: string): string {
    return ({ 'tamaño': 'Otro tamaño', color: 'Otro color', pack: 'Paquete', relacionado: 'Producto relacionado', otro: 'Otra idea' } as Record<string, string>)[k] || k;
  }
  trackById = (_: number, x: { id?: string; itemId?: string }) => x.id || x.itemId;
  trackByIndex = (i: number) => i;
}
