import { Injectable, OnDestroy } from '@angular/core';
import { AgChartTheme } from 'ag-charts-community';
import { Subscription } from 'rxjs';
import { Theme, ThemeService } from './theme.service';

/**
 * Tema único de ag-charts (baseTheme + paleta de la Dirección B).
 * Los colores salen de los tokens CSS de src/styles.scss, así que claro/oscuro
 * se resuelve leyendo las variables del <body> cada vez que cambia ThemeService.
 * Uso: `options.theme = chartTheme.current` y suscribirse a `onChange` para refrescar.
 */
@Injectable({ providedIn: 'root' })
export class ChartThemeService implements OnDestroy {
  private sub: Subscription;
  private listeners = new Set<(theme: AgChartTheme) => void>();
  private _current: AgChartTheme;

  constructor(private themeService: ThemeService) {
    this._current = this.build(themeService.getCurrentTheme());
    this.sub = themeService.theme$.subscribe(mode => {
      this._current = this.build(mode);
      this.listeners.forEach(fn => fn(this._current));
    });
  }

  get current(): AgChartTheme {
    return this._current;
  }

  /** Avisa cuando cambia el tema claro/oscuro. Devuelve la función para darse de baja. */
  onChange(fn: (theme: AgChartTheme) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  ngOnDestroy(): void {
    this.sub.unsubscribe();
  }

  private build(mode: Theme): AgChartTheme {
    const css = getComputedStyle(document.body);
    const hsl = (name: string) => this.hslTripletToHex(css.getPropertyValue(name));
    const raw = (name: string) => css.getPropertyValue(name).trim();

    const text = hsl('--foreground');
    const muted = hsl('--muted-foreground');
    const border = hsl('--border');
    const grid = raw('--ds-grid');
    const font = raw('--font');
    const palette = ['--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5'].map(hsl);

    const axis = {
      label: { color: muted, fontFamily: font, fontSize: 11 },
      title: { color: muted, fontFamily: font, fontSize: 12, fontWeight: 'normal' as const },
      line: { stroke: border },
      tick: { stroke: border },
    };

    return {
      baseTheme: mode === 'dark' ? 'ag-default-dark' : 'ag-default',
      palette: { fills: palette, strokes: palette },
      overrides: {
        common: {
          background: { fill: 'transparent' },
          axes: {
            number: { ...axis, gridLine: { style: [{ stroke: grid, lineDash: [] }] } },
            category: { ...axis, gridLine: { style: [{ stroke: grid, lineDash: [] }] } },
          },
          legend: {
            item: { label: { color: text, fontFamily: font, fontSize: 12, fontWeight: 'normal' } },
          },
        },
        line: { series: { strokeWidth: 2, marker: { enabled: false } } },
        bar: { series: { cornerRadius: 4, strokeWidth: 0 } },
      },
    } as AgChartTheme;
  }

  /** "243.4 75.4% 58.6%" -> "#4f46e5" (ag-charts no entiende hsl() con espacios). */
  private hslTripletToHex(triplet: string): string {
    const m = triplet.trim().match(/^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/);
    if (!m) return triplet.trim();
    const h = +m[1], s = +m[2] / 100, l = +m[3] / 100;
    const a = s * Math.min(l, 1 - l);
    const f = (n: number) => {
      const k = (n + h / 30) % 12;
      const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
      return Math.round(255 * c).toString(16).padStart(2, '0');
    };
    return `#${f(0)}${f(8)}${f(4)}`;
  }
}
