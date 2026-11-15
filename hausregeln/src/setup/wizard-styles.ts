/**
 * The look of the step-by-step assistants: the setup wizard (wizard.ts) and the feature assistants
 * (assistant/*.ts) share it, so every assistant reads the same: header with count and progress, a scrolling
 * body with intro, choice cards and grouped rows, a footer with Zurück / Überspringen / Weiter.
 */
import { css } from 'lit';

export const wizardStyles = css`
  :host {
    display: flex;
    flex-direction: column;
    min-height: 0;
    max-height: 100%;
  }
  header {
    display: flex;
    align-items: center;
    gap: var(--hr-space-3);
    padding: var(--hr-space-4) var(--hr-space-5) var(--hr-space-2);
  }
  header .grow {
    flex: 1;
    min-width: 0;
  }
  .progress {
    display: flex;
    gap: 4px;
    margin-top: var(--hr-space-2);
  }
  .progress span {
    flex: 1;
    height: 4px;
    border-radius: 2px;
    background: var(--hr-fill);
  }
  .progress span.on {
    background: var(--hr-accent);
  }
  .count {
    font-size: var(--hr-text-caption);
    color: var(--hr-label-2);
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  h2 {
    font-size: var(--hr-text-title2);
    margin-top: 2px;
  }
  .body {
    overflow-y: auto;
    padding: var(--hr-space-3) var(--hr-space-5) var(--hr-space-5);
    display: flex;
    flex-direction: column;
    gap: var(--hr-space-4);
    min-height: 0;
    flex: 1;
  }
  .body > * {
    flex-shrink: 0;
  }
  .intro {
    color: var(--hr-label-2);
    font-size: var(--hr-text-subhead);
    line-height: 1.5;
    max-width: 60ch;
  }
  .intro b {
    color: var(--hr-label);
  }
  footer {
    display: flex;
    align-items: center;
    gap: var(--hr-space-2);
    padding: var(--hr-space-3) var(--hr-space-5) calc(var(--hr-space-4) + env(safe-area-inset-bottom, 0px));
    border-top: 0.5px solid var(--hr-separator);
  }
  footer .spacer {
    flex: 1;
  }
  .choice {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 220px), 1fr));
    gap: var(--hr-space-3);
  }
  .choice button {
    display: flex;
    align-items: flex-start;
    gap: var(--hr-space-3);
    padding: var(--hr-space-4);
    border-radius: var(--hr-radius-l);
    background: var(--hr-surface);
    box-shadow: var(--hr-shadow-1);
    text-align: left;
  }
  .choice button .ic {
    color: var(--hr-label-2);
    margin-top: 2px;
  }
  .choice button small {
    display: block;
    color: var(--hr-label-2);
    font-size: var(--hr-text-footnote);
    margin-top: 2px;
    line-height: 1.35;
  }
  .choice button[aria-pressed='true'] {
    box-shadow: inset 0 0 0 2px var(--hr-accent);
  }
  .choice button[aria-pressed='true'] .ic {
    color: var(--hr-accent);
  }
  .box {
    color: var(--hr-accent);
    display: flex;
  }
  .box.off {
    color: var(--hr-label-3);
  }
  h3 {
    font-size: var(--hr-text-footnote);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--hr-label-2);
    margin: var(--hr-space-2) 0 0 var(--hr-space-1);
  }
  .anatomy {
    display: grid;
    gap: var(--hr-space-2);
    padding: var(--hr-space-4);
    font-family: var(--hr-font-sentence, inherit);
    line-height: 1.5;
  }
  .anatomy div {
    display: flex;
    gap: var(--hr-space-3);
    align-items: baseline;
  }
  .anatomy .kw {
    min-width: 64px;
  }
  .anatomy small {
    color: var(--hr-label-2);
  }
  .ex {
    display: flex;
    flex-direction: column;
    gap: var(--hr-space-2);
    padding: var(--hr-space-4);
  }
  .ex p {
    line-height: 1.45;
  }
  .ex small {
    color: var(--hr-label-2);
    font-size: var(--hr-text-footnote);
  }
  .ex .btn {
    align-self: flex-start;
  }
  .note {
    font-size: var(--hr-text-footnote);
    color: var(--hr-label-2);
    line-height: 1.4;
  }
  .ok {
    color: color-mix(in srgb, var(--hr-green) 75%, var(--hr-label));
    font-weight: 600;
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .sum .row .ic.on {
    color: var(--hr-green);
  }
  .sum .row .ic.off {
    color: var(--hr-label-3);
  }
  .err {
    color: var(--hr-red);
    font-size: var(--hr-text-footnote);
  }
  input.pin {
    flex: 1;
    min-height: 40px;
    border: 0;
    background: transparent;
    font-size: var(--hr-text-body);
  }
  .welcome-ic {
    color: var(--hr-accent);
  }
  ul.plain {
    margin: 0;
    padding-left: 1.2em;
    color: var(--hr-label-2);
    font-size: var(--hr-text-subhead);
    line-height: 1.6;
  }
  @media (max-width: 520px) {
    header,
    .body,
    footer {
      padding-left: var(--hr-space-4);
      padding-right: var(--hr-space-4);
    }
    footer .btn {
      padding: 0 var(--hr-space-3);
    }
  }
`;
