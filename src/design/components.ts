import { css } from 'lit';

/** Shared building blocks (buttons, segmented controls, chips, rows, fields). Uses tokens only. */
export const components = css`
  * {
    box-sizing: border-box;
  }
  :host {
    font-family: var(--fp-font);
    color: var(--fp-label);
    -webkit-font-smoothing: antialiased;
    -webkit-tap-highlight-color: transparent;
  }
  button {
    font: inherit;
    color: inherit;
    border: 0;
    margin: 0;
    padding: 0;
    background: none;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
  }
  button:focus-visible,
  input:focus-visible,
  [tabindex]:focus-visible {
    outline: 2px solid var(--fp-accent);
    outline-offset: 2px;
  }
  ha-icon {
    --mdc-icon-size: var(--fp-icon);
    display: inline-flex;
  }

  /* Pressable: subtle scale feedback (transform only) */
  .pressable {
    transition: transform var(--fp-dur-fast) var(--fp-ease), opacity var(--fp-dur-fast) var(--fp-ease);
  }
  .pressable:active {
    transform: scale(0.96);
  }

  /* Round icon button, 44px hit area */
  .icon-btn {
    width: var(--fp-hit);
    height: var(--fp-hit);
    border-radius: var(--fp-radius-full);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--fp-fill);
    color: var(--fp-label);
    flex: none;
  }
  .icon-btn.plain {
    background: transparent;
  }
  .icon-btn.raised {
    background: var(--fp-surface);
    box-shadow: var(--fp-shadow-2);
  }
  .icon-btn.accent {
    background: var(--fp-accent);
    color: var(--fp-on-accent);
  }
  .icon-btn[disabled] {
    opacity: 0.35;
    pointer-events: none;
  }
  .icon-btn ha-icon {
    --mdc-icon-size: 22px;
  }

  /* Text buttons */
  .btn {
    min-height: var(--fp-hit);
    padding: 0 var(--fp-space-5);
    border-radius: var(--fp-radius-full);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--fp-space-2);
    font-size: var(--fp-text-subhead);
    font-weight: var(--fp-weight-semibold);
    background: var(--fp-fill);
    color: var(--fp-label);
    white-space: nowrap;
  }
  .btn.accent {
    background: var(--fp-accent);
    color: var(--fp-on-accent);
  }
  .btn.tinted {
    background: color-mix(in srgb, var(--fp-accent) 14%, transparent);
    color: var(--fp-accent);
  }
  .btn.danger {
    background: color-mix(in srgb, var(--fp-red) 12%, transparent);
    color: var(--fp-red);
  }
  .btn.plain {
    background: transparent;
    color: var(--fp-accent);
    padding: 0 var(--fp-space-3);
  }
  .btn.block {
    width: 100%;
  }
  .btn[disabled] {
    opacity: 0.35;
    pointer-events: none;
  }
  .btn ha-icon {
    --mdc-icon-size: 20px;
  }

  /* Segmented control with sliding thumb */
  .segmented {
    position: relative;
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: minmax(0, 1fr);
    padding: 3px;
    border-radius: var(--fp-radius-m);
    background: var(--fp-fill);
    min-height: var(--fp-hit);
    isolation: isolate;
  }
  .segmented .thumb {
    position: absolute;
    top: 3px;
    bottom: 3px;
    left: 3px;
    border-radius: 11px;
    background: var(--fp-surface-raised);
    box-shadow: var(--fp-shadow-1);
    transition: transform var(--fp-dur) var(--fp-ease);
    z-index: -1;
  }
  .segmented button {
    min-height: 38px;
    padding: 0 var(--fp-space-3);
    font-size: var(--fp-text-footnote);
    font-weight: var(--fp-weight-semibold);
    color: var(--fp-label-2);
    border-radius: 11px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .segmented button[aria-pressed='true'] {
    color: var(--fp-label);
  }

  /* Chips */
  .chip {
    min-height: var(--fp-hit);
    padding: 0 var(--fp-space-4);
    border-radius: var(--fp-radius-full);
    display: inline-flex;
    align-items: center;
    gap: var(--fp-space-2);
    background: var(--fp-fill);
    font-size: var(--fp-text-footnote);
    font-weight: var(--fp-weight-semibold);
    color: var(--fp-label);
    white-space: nowrap;
  }
  .chip[aria-pressed='true'] {
    background: var(--fp-accent);
    color: var(--fp-on-accent);
  }
  .chip ha-icon {
    --mdc-icon-size: 18px;
  }

  /* iOS switch: visual 51x31, hit area 44px tall */
  .switch {
    position: relative;
    width: 60px;
    height: var(--fp-hit);
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .switch .track {
    position: relative;
    width: 51px;
    height: 31px;
    border-radius: var(--fp-radius-full);
    background: var(--fp-fill-strong);
    overflow: hidden;
  }
  .switch .track::before {
    content: '';
    position: absolute;
    inset: 0;
    background: var(--fp-green);
    opacity: 0;
    transition: opacity var(--fp-dur) var(--fp-ease);
  }
  .switch .knob {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 27px;
    height: 27px;
    border-radius: 50%;
    background: #fff;
    box-shadow: 0 3px 8px rgba(0, 0, 0, 0.15), 0 1px 1px rgba(0, 0, 0, 0.16);
    transition: transform var(--fp-dur) var(--fp-ease);
  }
  .switch[aria-checked='true'] .track::before {
    opacity: 1;
  }
  .switch[aria-checked='true'] .knob {
    transform: translateX(20px);
  }

  /* Grouped list (inset) */
  .group {
    background: var(--fp-surface);
    border-radius: var(--fp-radius-m);
    overflow: hidden;
  }
  .row {
    display: flex;
    align-items: center;
    gap: var(--fp-space-3);
    min-height: 52px;
    padding: var(--fp-space-1) var(--fp-space-4);
    position: relative;
    width: 100%;
    text-align: left;
  }
  .row + .row::before {
    content: '';
    position: absolute;
    top: 0;
    left: var(--fp-space-4);
    right: 0;
    height: 1px;
    background: var(--fp-separator);
    transform: scaleY(0.5);
    transform-origin: top;
  }
  .row .grow {
    flex: 1;
    min-width: 0;
  }
  .row .title {
    font-size: var(--fp-text-body);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row .subtitle {
    font-size: var(--fp-text-footnote);
    color: var(--fp-label-2);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row .trailing {
    color: var(--fp-label-2);
    font-size: var(--fp-text-subhead);
    flex: none;
  }

  /* Collapsible group: rarely needed settings stay out of the way */
  details.fold {
    margin-top: var(--fp-space-3);
  }
  details.fold > summary {
    list-style: none;
    display: flex;
    align-items: center;
    gap: var(--fp-space-3);
    min-height: 52px;
    padding: 0 var(--fp-space-4);
    cursor: pointer;
    font-size: var(--fp-text-body);
    background: var(--fp-surface);
    border-radius: var(--fp-radius-m);
    -webkit-tap-highlight-color: transparent;
  }
  details.fold > summary::-webkit-details-marker {
    display: none;
  }
  details.fold > summary .grow {
    flex: 1;
    min-width: 0;
  }
  details.fold > summary .sub {
    color: var(--fp-label-2);
    font-size: var(--fp-text-subhead);
    white-space: nowrap;
  }
  details.fold > summary ha-icon.chev {
    color: var(--fp-label-3);
    --mdc-icon-size: 20px;
    transition: transform var(--fp-dur-fast, 0.2s) var(--fp-ease, ease);
  }
  details.fold[open] > summary ha-icon.chev {
    transform: rotate(90deg);
  }
  details.fold > .fold-body {
    padding: var(--fp-space-2) 0 var(--fp-space-2);
  }
  details.fold > .fold-body > .section-title:first-child {
    margin-top: var(--fp-space-2);
  }
  .section-title {
    font-size: var(--fp-text-footnote);
    font-weight: var(--fp-weight-semibold);
    color: var(--fp-label-2);
    text-transform: uppercase;
    letter-spacing: var(--fp-tracking-caps);
    margin: var(--fp-space-5) var(--fp-space-4) var(--fp-space-2);
  }

  /* Text field */
  .field {
    width: 100%;
    min-height: var(--fp-hit);
    padding: 0 var(--fp-space-4);
    border-radius: var(--fp-radius-s);
    border: 0;
    background: var(--fp-fill);
    color: var(--fp-label);
    font: inherit;
    font-size: var(--fp-text-body);
    outline: none;
  }
  .field::placeholder {
    color: var(--fp-label-3);
  }
  .search {
    position: relative;
  }
  .search ha-icon {
    position: absolute;
    left: 12px;
    top: 50%;
    transform: translateY(-50%);
    color: var(--fp-label-2);
    --mdc-icon-size: 20px;
    pointer-events: none;
  }
  .search .field {
    padding-left: 40px;
  }

  /* Icon tile (state carrier) */
  .tile {
    width: var(--fp-hit);
    height: var(--fp-hit);
    border-radius: var(--fp-radius-full);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--fp-fill);
    color: var(--fp-label-2);
    flex: none;
    transition: opacity var(--fp-dur) var(--fp-ease);
  }
  .tile.on {
    background: var(--tile-color, var(--fp-state-light));
    color: var(--tile-ink, var(--fp-state-on-light));
  }

  .muted {
    color: var(--fp-label-2);
  }
  .num {
    font-variant-numeric: tabular-nums;
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
  }
`;
