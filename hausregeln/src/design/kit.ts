import { css } from 'lit';

/**
 * Building blocks of the pages since the redesign (designed in the doku portal, .claude/doku/design/*-gen.html):
 * a grid of equal tiles (.rl-grid / .rl-tile), and inside the pop-ups (<hr-pop>) sections (.rl-sec), boxes
 * (.rl-box with .line rows), lists (.rl-list with .rl-item rows), hints (.rl-info), choice chips (.rl-tg) and
 * small chips (.rl-chip). The class names are the portal's, so a design can be carried over as it is.
 * Colours only through tokens.
 */
export const kit = css`
  .rl-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: var(--hr-space-4);
  }
  .rl-grid.four {
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  }
  .rl-tile {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: var(--hr-space-3);
    min-height: 176px;
    padding: var(--hr-space-5);
    background: var(--hr-surface);
    border-radius: var(--hr-radius-xl);
    box-shadow: var(--hr-shadow-1);
    text-align: left;
    min-width: 0;
  }
  .rl-tile.small {
    min-height: 132px;
  }
  .rl-tile:hover {
    box-shadow: var(--hr-shadow-2);
  }
  /* the whole tile opens its pop-up; switches and buttons inside lie above it */
  .rl-open {
    position: absolute;
    inset: 0;
    border: 0;
    background: transparent;
    border-radius: inherit;
    cursor: pointer;
    z-index: 1;
  }
  .rl-tile .switch,
  .rl-tile .over {
    position: relative;
    z-index: 2;
  }
  .rl-tile .top {
    display: flex;
    align-items: center;
    gap: var(--hr-space-3);
  }
  .rl-ic {
    width: 48px;
    height: 48px;
    border-radius: var(--hr-radius-m);
    display: grid;
    place-items: center;
    background: var(--hr-fill);
    color: var(--hr-label-2);
    flex: none;
  }
  .rl-ic.small {
    width: 36px;
    height: 36px;
    border-radius: var(--hr-radius-s);
  }
  .rl-tile.lit .rl-ic {
    background: color-mix(in srgb, var(--hr-glow) 55%, transparent);
    color: var(--hr-orange);
  }
  .rl-tile.acc .rl-ic {
    background: color-mix(in srgb, var(--hr-accent) var(--hr-tint), transparent);
    color: var(--hr-accent);
  }
  .rl-tile.warn .rl-ic {
    background: color-mix(in srgb, var(--hr-red) var(--hr-tint), transparent);
    color: var(--hr-red);
  }
  .rl-tile h2,
  .rl-tile h3 {
    font-size: var(--hr-text-title3);
    font-weight: 700;
    letter-spacing: -0.01em;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .rl-tile .grow {
    flex: 1;
    min-width: 0;
  }
  .rl-tile .state {
    font-size: var(--hr-text-footnote);
    color: var(--hr-label-2);
  }
  .rl-tile .text {
    font-size: var(--hr-text-subhead);
    line-height: 1.4;
    color: var(--hr-label);
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .rl-tile.off {
    opacity: 0.7;
  }
  .rl-tile .foot {
    margin-top: auto;
    display: flex;
    align-items: center;
    gap: var(--hr-space-2);
    justify-content: space-between;
    flex-wrap: wrap;
    font-size: var(--hr-text-footnote);
    color: var(--hr-label-2);
  }
  .rl-tile .foot b {
    color: var(--hr-label);
    font-weight: 600;
  }
  .rl-tile .go {
    color: var(--hr-label-3);
  }
  .rl-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .rl-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: var(--hr-text-caption);
    font-weight: 600;
    padding: 4px 10px;
    border-radius: var(--hr-radius-full);
    background: var(--hr-fill);
    color: var(--hr-label-2);
    white-space: nowrap;
  }
  .rl-chip.yes {
    background: color-mix(in srgb, var(--hr-green) var(--hr-tint), transparent);
    color: var(--hr-green);
  }
  .rl-chip.acc {
    background: color-mix(in srgb, var(--hr-accent) var(--hr-tint), transparent);
    color: var(--hr-accent);
  }
  .rl-chip.warm {
    background: color-mix(in srgb, var(--hr-orange) var(--hr-tint), transparent);
    color: var(--hr-orange);
  }
  .rl-chip.bad {
    background: color-mix(in srgb, var(--hr-red) var(--hr-tint), transparent);
    color: var(--hr-red);
  }
  /* "1 Raum ausgeblendet (Keller) · Räume anordnen" under a grid */
  .rl-hidden {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--hr-space-3);
    font-size: var(--hr-text-footnote);
    color: var(--hr-label-2);
  }
  .rl-hidden button {
    color: var(--hr-accent);
    font-weight: 600;
    font-size: inherit;
  }
  /* a heading over a group of tiles */
  .rl-group-h {
    display: flex;
    align-items: baseline;
    gap: var(--hr-space-2);
    margin: var(--hr-space-2) var(--hr-space-1) calc(-1 * var(--hr-space-2));
    font-size: var(--hr-text-title3);
    font-weight: 700;
  }
  .rl-group-h .muted {
    font-size: var(--hr-text-footnote);
    font-weight: 500;
  }

  /* inside pop-ups */
  .rl-sec {
    display: flex;
    flex-direction: column;
    gap: var(--hr-space-2);
  }
  .rl-sec > .eyebrow,
  .rl-lbl {
    margin-left: var(--hr-space-2);
  }
  .rl-sec h3 {
    font-size: var(--hr-text-footnote);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--hr-label-2);
    margin: 0 var(--hr-space-2);
  }
  .rl-box {
    background: var(--hr-surface);
    border-radius: var(--hr-radius-l);
    box-shadow: var(--hr-shadow-1);
    padding: var(--hr-space-4);
    display: flex;
    flex-direction: column;
    gap: var(--hr-space-3);
  }
  .rl-box .line {
    display: flex;
    align-items: center;
    gap: var(--hr-space-3);
    flex-wrap: wrap;
  }
  .rl-box .line .grow {
    flex: 1 1 200px;
    min-width: 0;
  }
  .rl-box b,
  .rl-list b {
    font-size: var(--hr-text-body);
    font-weight: 600;
    display: block;
  }
  .rl-box small,
  .rl-note,
  .rl-list small {
    display: block;
    font-size: var(--hr-text-footnote);
    color: var(--hr-label-2);
    line-height: 1.4;
  }
  .rl-box .acts {
    display: flex;
    gap: var(--hr-space-2);
    flex-wrap: wrap;
  }
  .rl-box .line + .line,
  .rl-box .sep {
    border-top: 0.5px solid var(--hr-separator);
    padding-top: var(--hr-space-3);
  }
  .rl-list {
    background: var(--hr-surface);
    border-radius: var(--hr-radius-l);
    box-shadow: var(--hr-shadow-1);
    overflow: hidden;
  }
  .rl-item {
    display: flex;
    align-items: center;
    gap: var(--hr-space-3);
    min-height: 56px;
    padding: var(--hr-space-2) var(--hr-space-4);
    width: 100%;
    text-align: left;
  }
  .rl-item + .rl-item {
    border-top: 0.5px solid var(--hr-separator);
  }
  .rl-item .grow {
    flex: 1;
    min-width: 0;
  }
  .rl-item .main {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: var(--hr-space-3);
    text-align: left;
    min-height: 52px;
  }
  .rl-item .go {
    color: var(--hr-label-3);
  }
  .rl-item .ico {
    width: 36px;
    height: 36px;
    border-radius: var(--hr-radius-s);
    display: grid;
    place-items: center;
    background: var(--hr-fill);
    color: var(--hr-label-2);
    flex: none;
  }
  .rl-item.off {
    opacity: 0.55;
  }
  .rl-info {
    display: flex;
    gap: var(--hr-space-3);
    align-items: flex-start;
    padding: var(--hr-space-3) var(--hr-space-4);
    border-radius: var(--hr-radius-m);
    background: color-mix(in srgb, var(--hr-accent) var(--hr-tint), transparent);
    font-size: var(--hr-text-footnote);
    line-height: 1.4;
  }
  .rl-info .ic {
    color: var(--hr-accent);
    margin-top: 1px;
  }
  .rl-info.warn {
    background: color-mix(in srgb, var(--hr-orange) var(--hr-tint), transparent);
  }
  .rl-info.warn .ic {
    color: var(--hr-orange);
  }
  .rl-now {
    display: flex;
    align-items: center;
    gap: var(--hr-space-3);
    padding: var(--hr-space-4);
    border-radius: var(--hr-radius-l);
    background: color-mix(in srgb, var(--hr-accent) var(--hr-tint), transparent);
  }
  .rl-now .grow {
    flex: 1;
    min-width: 0;
  }
  .rl-now b {
    display: block;
    font-size: var(--hr-text-body);
    font-weight: 700;
  }
  .rl-now small {
    font-size: var(--hr-text-footnote);
    color: var(--hr-label-2);
  }
  /* choice chips: buttons with aria-pressed (one or several) */
  .rl-tg {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .rl-tg > button {
    display: inline-flex;
    flex-direction: column;
    justify-content: center;
    min-height: 44px;
    padding: 4px 14px;
    border-radius: var(--hr-radius-m);
    background: var(--hr-fill);
    color: var(--hr-label-2);
    font-size: var(--hr-text-subhead);
    font-weight: 600;
    line-height: 1.2;
    text-align: left;
  }
  .rl-tg > button small {
    font-size: var(--hr-text-caption);
    font-weight: 500;
  }
  .rl-tg > button[aria-pressed='true'] {
    background: color-mix(in srgb, var(--hr-accent) 16%, transparent);
    color: var(--hr-accent);
    box-shadow: inset 0 0 0 1.5px var(--hr-accent);
  }
  .rl-tg > button[disabled] {
    opacity: 0.55;
    pointer-events: none;
  }
  .rl-tg.two > button {
    flex: 1;
  }
  .rl-state {
    display: flex;
    align-items: center;
    gap: var(--hr-space-4);
  }
  .rl-state .grow {
    flex: 1;
    min-width: 0;
  }
  .rl-state h2 {
    font-size: var(--hr-text-title2);
    font-weight: 800;
    letter-spacing: -0.02em;
  }
  .rl-state p {
    font-size: var(--hr-text-footnote);
    color: var(--hr-label-2);
    margin-top: 2px;
  }
  @media (max-width: 640px) {
    .rl-grid,
    .rl-grid.four {
      grid-template-columns: 1fr;
    }
    .rl-tile {
      min-height: 0;
    }
  }
`;
