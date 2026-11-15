import { css, html, svg, type TemplateResult } from 'lit';
import {
  mdiAutoFix,
  mdiCallMerge,
  mdiFloorPlan,
  mdiHomeAccount,
  mdiLightbulbGroup,
  mdiRadiator,
  mdiSpeaker,
  mdiWaterAlert,
  mdiWeatherNight,
  mdiWindowOpenVariant,
  mdiTelevision,
  mdiSofa,
  mdiBedKingOutline,
  mdiDesk,
  mdiPowerSocketEu,
  mdiFan,
  mdiRobotVacuum,
  mdiShieldHomeOutline,
  mdiShapeOutline,
  mdiMapMarkerOutline,
  mdiPencilOutline,
  mdiBicycle,
  mdiCar,
  mdiGarage,
  mdiGreenhouse,
  mdiHomeCityOutline,
  mdiShieldOutline,
} from '@mdi/js';

/** Icon names the integration sends (suggestions, behaviours) */
const NAMED: Record<string, string> = {
  merge: mdiCallMerge,
  fix: mdiAutoFix,
  rooms: mdiFloorPlan,
  heating: mdiRadiator,
  leak: mdiWaterAlert,
  light: mdiLightbulbGroup,
  window: mdiWindowOpenVariant,
  night: mdiWeatherNight,
  media: mdiSpeaker,
  home: mdiHomeAccount,
  tv: mdiTelevision,
  sofa: mdiSofa,
  bed: mdiBedKingOutline,
  desk: mdiDesk,
  outlet: mdiPowerSocketEu,
  fan: mdiFan,
  vacuum: mdiRobotVacuum,
  shield: mdiShieldHomeOutline,
  group: mdiShapeOutline,
};

/** An SVG path, a named icon, or an "mdi:…" name (rendered by Home Assistant's ha-icon). */
/** Icons by "mdi:" name when Home Assistant's ha-icon is not there (preview) */
const MDI_FALLBACK: Record<string, string> = {
  'mdi:home': mdiHomeAccount,
  'mdi:stove': mdiRadiator,
  'mdi:sofa': mdiSofa,
  'mdi:sofa-outline': mdiSofa,
  'mdi:bed-king-outline': mdiBedKingOutline,
  'mdi:desk': mdiDesk,
  // object alarms ("Weitere Alarme")
  'mdi:bicycle': mdiBicycle,
  'mdi:car': mdiCar,
  'mdi:garage': mdiGarage,
  'mdi:greenhouse': mdiGreenhouse,
  'mdi:home-city-outline': mdiHomeCityOutline,
  'mdi:shield-outline': mdiShieldOutline,
};

export function icon(path: string, size = 20): TemplateResult {
  if (path?.startsWith('mdi:') && !customElements.get('ha-icon')) return icon(MDI_FALLBACK[path] ?? mdiMapMarkerOutline, size);
  if (path?.startsWith('mdi:'))
    return html`<ha-icon class="ic" .icon=${path} style="--mdc-icon-size:${size}px;width:${size}px;height:${size}px;display:inline-flex"></ha-icon>`;
  const d = NAMED[path] ?? path;
  return html`<svg class="ic" viewBox="0 0 24 24" width=${size} height=${size} aria-hidden="true">${svg`<path d=${d}></path>`}</svg>`;
}

/** Shared component styles. Colours only through tokens. */
export const shared = css`
  :host {
    font-family: var(--hr-font);
    color: var(--hr-label);
    -webkit-font-smoothing: antialiased;
    -webkit-tap-highlight-color: transparent;
  }
  * {
    box-sizing: border-box;
  }
  .ic {
    fill: currentColor;
    flex: none;
    display: block;
  }
  button {
    font: inherit;
    color: inherit;
    border: 0;
    background: none;
    padding: 0;
    cursor: pointer;
  }
  button:focus-visible,
  input:focus-visible,
  textarea:focus-visible,
  [tabindex]:focus-visible {
    outline: 3px solid color-mix(in srgb, var(--hr-accent) 55%, transparent);
    outline-offset: 2px;
  }
  input,
  textarea {
    font: inherit;
    color: inherit;
  }
  h1,
  h2,
  h3,
  p {
    margin: 0;
  }
  h2 {
    font-size: var(--hr-text-title3);
    font-weight: 700;
    letter-spacing: -0.01em;
    text-wrap: balance;
  }
  .eyebrow {
    font-size: var(--hr-text-caption);
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--hr-label-2);
  }
  .muted {
    color: var(--hr-label-2);
  }

  /* Buttons */
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--hr-space-2);
    min-height: var(--hr-hit);
    padding: 0 var(--hr-space-4);
    border-radius: var(--hr-radius-full);
    font-size: var(--hr-text-subhead);
    font-weight: 600;
    background: var(--hr-fill);
    color: var(--hr-label);
    transition: transform var(--hr-dur-fast) var(--hr-ease), opacity var(--hr-dur-fast);
    white-space: nowrap;
  }
  a.btn {
    text-decoration: none;
  }
  .btn:active {
    transform: scale(0.97);
  }
  .btn.primary {
    background: var(--hr-accent);
    color: var(--hr-on-accent);
  }
  .btn.tinted {
    background: color-mix(in srgb, var(--hr-accent) var(--hr-tint), transparent);
    color: var(--hr-accent);
  }
  .btn.danger {
    background: color-mix(in srgb, var(--hr-red) var(--hr-tint), transparent);
    color: var(--hr-red);
  }
  .btn.small {
    min-height: 34px;
    padding: 0 var(--hr-space-3);
    font-size: var(--hr-text-footnote);
  }
  .btn.plain {
    background: none;
    color: var(--hr-accent);
    padding: 0 var(--hr-space-2);
  }
  .btn[disabled] {
    opacity: 0.4;
    pointer-events: none;
  }
  .icon-btn {
    width: var(--hr-hit);
    height: var(--hr-hit);
    display: grid;
    place-items: center;
    border-radius: var(--hr-radius-full);
    color: var(--hr-label-2);
  }
  .icon-btn:hover {
    background: var(--hr-fill);
  }

  /* Surfaces */
  .card {
    background: var(--hr-surface);
    border-radius: var(--hr-radius-l);
    box-shadow: var(--hr-shadow-1);
  }
  .group {
    background: var(--hr-surface);
    border-radius: var(--hr-radius-m);
    overflow: hidden;
  }
  .row {
    display: flex;
    align-items: center;
    gap: var(--hr-space-3);
    min-height: 52px;
    padding: var(--hr-space-2) var(--hr-space-4);
    width: 100%;
    text-align: left;
  }
  .group > .row + .row,
  .group > * + .row {
    border-top: 0.5px solid var(--hr-separator);
  }
  /* a row with its own action on the right (fixButton): the row is a div, the main part a button */
  .row.fixrow {
    padding: 0 var(--hr-space-2) 0 0;
    gap: 0;
  }
  .fixrow > .pick {
    display: flex;
    flex: 1;
    align-items: center;
    gap: var(--hr-space-3);
    min-height: 52px;
    min-width: 0;
    padding: var(--hr-space-2) var(--hr-space-4);
    text-align: left;
  }
  .fix-btn {
    flex: none;
    opacity: 0.7;
  }
  .row .grow {
    flex: 1;
    min-width: 0;
  }
  .row .title {
    font-size: var(--hr-text-body);
  }
  .row .sub {
    font-size: var(--hr-text-footnote);
    color: var(--hr-label-2);
  }

  /* Filter chips / segmented */
  .seg {
    display: inline-flex;
    padding: 3px;
    gap: 2px;
    border-radius: var(--hr-radius-full);
    background: var(--hr-fill);
    max-width: 100%;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .seg::-webkit-scrollbar {
    display: none;
  }
  .seg button {
    min-height: 34px;
    padding: 0 var(--hr-space-4);
    border-radius: var(--hr-radius-full);
    font-size: var(--hr-text-footnote);
    font-weight: 600;
    color: var(--hr-label-2);
    white-space: nowrap;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .seg button[disabled] {
    opacity: 0.4;
    pointer-events: none;
  }
  .seg button[aria-pressed='true'] {
    background: var(--hr-surface-raised);
    color: var(--hr-label);
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
  }
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 24px;
    padding: 0 10px;
    border-radius: var(--hr-radius-full);
    font-size: var(--hr-text-caption);
    font-weight: 600;
    background: var(--hr-fill);
    color: var(--hr-label-2);
    white-space: nowrap;
  }
  .pill.live {
    background: color-mix(in srgb, var(--hr-green) var(--hr-tint), transparent);
    color: color-mix(in srgb, var(--hr-green) 70%, var(--hr-label));
  }
  .pill.warn {
    background: color-mix(in srgb, var(--hr-orange) var(--hr-tint), transparent);
    color: color-mix(in srgb, var(--hr-orange) 75%, var(--hr-label));
  }
  .pill.accent {
    background: color-mix(in srgb, var(--hr-accent) var(--hr-tint), transparent);
    color: var(--hr-accent);
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--hr-label-3);
    flex: none;
  }
  .dot.on {
    background: var(--hr-green);
  }
  .dot.warm {
    background: var(--hr-orange);
  }

  /* Sentence chips: one colour per part of a sentence */
  .tone-when {
    --tone: var(--hr-when);
  }
  .tone-while {
    --tone: var(--hr-while);
  }
  .tone-and {
    --tone: var(--hr-and);
  }
  .tone-then {
    --tone: var(--hr-then);
  }
  .tone-only {
    --tone: var(--hr-only);
  }
  .tone-alarm {
    --tone: var(--hr-red);
  }
  .kw {
    color: var(--tone);
    font-weight: 700;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 1px 9px 1px 7px;
    border-radius: 9px;
    background: color-mix(in srgb, var(--tone, var(--hr-accent)) var(--hr-tint), transparent);
    color: var(--hr-label);
    font-weight: 600;
    vertical-align: baseline;
    line-height: 1.5;
    white-space: nowrap;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .chip .ic {
    color: var(--tone);
    width: 1em;
    height: 1em;
  }
  .chip.verb {
    background: none;
    padding: 0 2px;
    font-weight: 500;
    white-space: normal;
  }
  .chip.missing {
    text-decoration: line-through;
    opacity: 0.6;
  }

  /* Switch */
  .switch {
    position: relative;
    width: 51px;
    height: 31px;
    flex: none;
    border-radius: var(--hr-radius-full);
    background: var(--hr-fill-strong);
    transition: background var(--hr-dur) var(--hr-ease);
  }
  .switch::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 27px;
    height: 27px;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.18);
    transition: transform var(--hr-dur) var(--hr-ease);
  }
  .switch[aria-checked='true'] {
    background: var(--hr-green);
  }
  .switch[disabled] {
    opacity: 0.4;
    pointer-events: none;
  }
  .switch[aria-checked='true']::after {
    transform: translateX(20px);
  }

  /* a switched-off feature (components/feature.ts) */
  .fhint {
    display: flex;
    align-items: center;
    gap: var(--hr-space-3);
    padding: var(--hr-space-3) var(--hr-space-4);
    border-radius: var(--hr-radius-m);
    background: var(--hr-fill);
    color: var(--hr-label-2);
    font-size: var(--hr-text-footnote);
    line-height: 1.4;
  }
  .fhint b {
    color: var(--hr-label);
    font-weight: 600;
  }
  .fhint .grow {
    flex: 1;
    min-width: 0;
  }
  /* area layout: every area is a column of sections, each with a title and one plain sentence */
  .area-sec {
    display: flex;
    flex-direction: column;
    gap: var(--hr-space-3);
    /* a link to a section scrolls it below the sticky navigation */
    scroll-margin-top: 72px;
  }
  .sec-head {
    display: flex;
    align-items: baseline;
    gap: var(--hr-space-2);
  }
  .lead {
    color: var(--hr-label-2);
    font-size: var(--hr-text-subhead);
    max-width: 66ch;
    line-height: 1.45;
  }
  /* a small fold for what is rarely needed ("Mehr", "Was wird gesendet?"): a link-like line with a chevron */
  details.more > summary {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-height: 36px;
    cursor: pointer;
    list-style: none;
    color: var(--hr-accent);
    font-size: var(--hr-text-footnote);
    font-weight: 600;
  }
  details.more > summary::-webkit-details-marker {
    display: none;
  }
  details.more > summary .ic {
    transition: transform var(--hr-dur) var(--hr-ease);
  }
  details.more[open] > summary .ic {
    transform: rotate(180deg);
  }
  details.more > .inner {
    display: flex;
    flex-direction: column;
    gap: var(--hr-space-3);
    padding-top: var(--hr-space-2);
  }

  .scroll-x {
    display: flex;
    gap: var(--hr-space-3);
    overflow-x: auto;
    scroll-snap-type: x mandatory;
    scrollbar-width: none;
    padding-bottom: 4px;
  }
  .scroll-x::-webkit-scrollbar {
    display: none;
  }

  @media (prefers-reduced-motion: reduce) {
    *,
    *::before,
    *::after {
      transition-duration: 1ms !important;
      animation-duration: 1ms !important;
    }
  }
`;

export function fire<T>(el: EventTarget, type: string, detail?: T): void {
  el.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
}

/** "Erkannt als … – ändern / nicht verwenden" next to an item of an automatically assembled list: opens the
 * device sheet of the panel (hr-device-fix), whose choice counts everywhere. */
export function fixButton(host: EventTarget, entityId: string): TemplateResult {
  return html`<button
    class="icon-btn fix-btn"
    aria-label="Erkannt als … ändern oder nicht verwenden"
    title="Ändern oder nicht verwenden"
    @click=${(e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      fire(host, 'hr-open-device', { entity_id: entityId });
    }}
  >
    ${icon(mdiPencilOutline, 18)}
  </button>`;
}
