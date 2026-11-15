import { css, html, type TemplateResult } from 'lit';
import { t } from '../i18n';
// i18n: complete

/**
 * Easy colours for a light setting: big, clearly visible colour fields (candle, warm, neutral, cold white, red, orange,
 * yellow, green, blue, purple, pink) plus a free colour. Values are lightspec colour strings ("kerze", "warm", "#ff2a1a" …).
 * Used where a simple light setting is chosen (Urlaubslicht, Reinschau-Licht); the full editor is <hr-light-action>.
 */
export const SWATCH_COLORS: [string, string, string][] = [
  // value, css colour of the field, i18n key
  ['kerze', '#ffb35c', 'sw.kerze'],
  ['warm', '#ffd08a', 'sw.warm'],
  ['neutral', '#fff1d6', 'sw.neutral'],
  ['kalt', '#dfeaff', 'sw.kalt'],
  ['#ff2a1a', '#ff2a1a', 'sw.red'],
  ['#ff7a00', '#ff7a00', 'sw.orange'],
  ['#ffd400', '#ffd400', 'sw.yellow'],
  ['#2ecc40', '#2ecc40', 'sw.green'],
  ['#1e64ff', '#1e64ff', 'sw.blue'],
  ['#8a2be2', '#8a2be2', 'sw.purple'],
  ['#ff4fa3', '#ff4fa3', 'sw.pink'],
];

export function swatches(value: string, set: (c: string) => void): TemplateResult {
  const free = /^#[0-9a-f]{6}$/i.test(value) && !SWATCH_COLORS.some(([v]) => v === value);
  return html`<div class="swatches" role="radiogroup" aria-label=${t('sw.title')}>
    ${SWATCH_COLORS.map(
      ([v, css, key]) => html`<button class="sw" role="radio" aria-pressed=${value === v ? 'true' : 'false'} title=${t(key as 'sw.kerze')} @click=${() => set(v)}>
        <span class="dot" style="background:${css}"></span><span class="lbl">${t(key as 'sw.kerze')}</span>
      </button>`,
    )}
    <label class="sw free" title=${t('sw.free')} aria-pressed=${free ? 'true' : 'false'}>
      <span class="dot" style="background:${free ? value : 'conic-gradient(red, yellow, lime, cyan, blue, magenta, red)'}"></span><span class="lbl">${t('sw.free')}</span>
      <input type="color" aria-label=${t('sw.free')} .value=${/^#[0-9a-f]{6}$/i.test(value) ? value : '#ff8a3d'} @input=${(e: Event) => set((e.target as HTMLInputElement).value)} />
    </label>
  </div>`;
}

export const swatchStyles = css`
  .swatches {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(76px, 1fr));
    gap: 8px;
  }
  .swatches .sw {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 8px 4px;
    border-radius: var(--hr-radius-m);
    background: var(--hr-fill);
    font-size: var(--hr-text-caption);
    font-weight: 600;
    color: var(--hr-label-2);
    cursor: pointer;
  }
  .swatches .sw[aria-pressed='true'] {
    box-shadow: inset 0 0 0 2px var(--hr-accent);
    color: var(--hr-label);
  }
  .swatches .dot {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.12);
  }
  .swatches .free input {
    position: absolute;
    inset: 0;
    opacity: 0;
    cursor: pointer;
  }
`;
