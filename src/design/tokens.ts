import { css } from 'lit';

/**
 * Design tokens. Every visual value used by the card, popups and editor comes from here.
 * Palette follows iOS system colors; dark values are applied with the [dark] host attribute.
 */
export const tokens = css`
  :host {
    /* Typography */
    --fp-font: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Pro Display', 'Segoe UI', Roboto,
      'Helvetica Neue', system-ui, sans-serif;
    --fp-text-caption: 12px;
    --fp-text-footnote: 13px;
    --fp-text-subhead: 15px;
    --fp-text-body: 17px;
    --fp-text-title3: 20px;
    --fp-text-title2: 22px;
    --fp-text-title1: 28px;
    --fp-text-large: 34px;
    --fp-text-display: 56px;
    --fp-weight-regular: 400;
    --fp-weight-medium: 500;
    --fp-weight-semibold: 600;
    --fp-weight-bold: 700;
    --fp-tracking-tight: -0.02em;
    --fp-tracking-caps: 0.06em;

    /* Spacing (4pt grid) */
    --fp-space-1: 4px;
    --fp-space-2: 8px;
    --fp-space-3: 12px;
    --fp-space-4: 16px;
    --fp-space-5: 20px;
    --fp-space-6: 24px;
    --fp-space-7: 32px;
    --fp-space-8: 40px;

    /* Radii */
    --fp-radius-s: 10px;
    --fp-radius-m: 14px;
    --fp-radius-l: 20px;
    --fp-radius-xl: 28px;
    --fp-radius-full: 999px;

    /* Sizes */
    --fp-hit: 44px;
    --fp-marker: 48px;
    --fp-icon: 24px;
    --fp-icon-s: 18px;

    /* Motion: only transform + opacity are animated */
    --fp-dur-fast: 150ms;
    --fp-dur: 200ms;
    --fp-dur-slow: 250ms;
    --fp-ease: cubic-bezier(0.2, 0.8, 0.2, 1);
    --fp-ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);

    /* Colors: light */
    --fp-accent: #007aff;
    --fp-on-accent: #ffffff;
    --fp-yellow: #ffcc00;
    --fp-orange: #ff9500;
    --fp-red: #ff3b30;
    --fp-green: #34c759;
    --fp-blue: #007aff;
    --fp-teal: #30b0c7;

    --fp-bg: #f2f2f7;
    --fp-surface: #ffffff;
    --fp-surface-2: #f2f2f7;
    --fp-surface-raised: #ffffff;
    --fp-fill: rgba(118, 118, 128, 0.12);
    --fp-fill-strong: rgba(120, 120, 128, 0.2);
    --fp-label: #1c1c1e;
    --fp-label-2: rgba(60, 60, 67, 0.62);
    --fp-label-3: rgba(60, 60, 67, 0.32);
    --fp-separator: rgba(60, 60, 67, 0.14);
    --fp-scrim: rgba(0, 0, 0, 0.22);

    /* Plan */
    --fp-plan-bg: #ebebf0;
    --fp-room: #ffffff;
    --fp-wall: #d1d1d6;
    --fp-grid: rgba(60, 60, 67, 0.07);
    --fp-grid-major: rgba(60, 60, 67, 0.13);
    --fp-glow: #ffdc8f;
    --fp-glow-edge: #ffdc8f;
    --fp-glow-edge-opacity: 0.08;
    --fp-glow-opacity: 0.26;
    --fp-press: rgba(0, 0, 0, 0.05);
    --fp-slider-fill: #ffffff;
    --fp-furniture: #f4f4f7;
    --fp-furniture-soft: #ebebf0;
    --fp-furniture-line: rgba(60, 60, 67, 0.22);
    --fp-plant: #b9dcb0;
    --fp-plant-2: #9fcf94;
    --fp-rug: rgba(120, 120, 128, 0.07);
    --fp-glass: #a6d4f2;
    --fp-glass-edge: #6fa8d0;
    --fp-frame: #ececf0;
    --fp-frame-edge: #b8b8c0;
    --fp-window-frame: #ffffff;
    --fp-door-edge: #9a9aa2;
    --fp-wall-top: #ffffff;
    --fp-wall-side: #ececf0;
    --fp-furniture-side: #e4e4ea;
    --fp-door: #ffffff;
    --fp-door-3d: #ddd6cb;
    --fp-door-2d: #e4ddd2;
    --fp-handle: #6e6e73;
    --fp-vac-trail: #a9d6ff;
    --fp-occupied: #2fb38a;
    --fp-sunbeam: #ffe39a;
    --fp-air: rgba(90, 160, 220, 0.75);
    --fp-floor-opacity: 1;
    --fp-paint-mix: 100%;
    --fp-sky-golden: rgba(255, 170, 90, 0.16);
    --fp-sky-twilight: rgba(120, 110, 200, 0.14);
    --fp-sky-night: rgba(40, 60, 130, 0.16);
    --fp-sun-glow: rgba(255, 214, 120, 0.42);
    --fp-sun-glow-golden: rgba(255, 160, 80, 0.45);
    --fp-star: rgba(80, 90, 140, 0);
    --fp-cloud: rgba(255, 255, 255, 0.95);
    --fp-cloud-shadow: rgba(30, 40, 60, 0.08);
    --fp-overcast: rgba(120, 130, 150, 0.14);
    --fp-haze: rgba(236, 239, 243, 0.14);
    --fp-fog: rgba(250, 251, 253, 0.8);
    --fp-rain: rgba(70, 105, 160, 0.5);
    --fp-snow: rgba(238, 242, 250, 0.98);
    --fp-flash: rgba(255, 255, 255, 0.6);

    /* State colors */
    --fp-state-light: #ffcc00;
    --fp-state-on-light: #1c1c1e;
    --fp-state-heat: #ff9500;
    --fp-state-cool: #0a84ff;
    --fp-state-active: #007aff;
    --fp-state-alert: #ff9500;

    /* Elevation */
    --fp-shadow-1: 0 1px 2px rgba(0, 0, 0, 0.08), 0 0 1px rgba(0, 0, 0, 0.06);
    --fp-shadow-2: 0 4px 14px rgba(0, 0, 0, 0.08), 0 1px 3px rgba(0, 0, 0, 0.06);
    --fp-shadow-3: 0 24px 60px rgba(0, 0, 0, 0.16), 0 6px 18px rgba(0, 0, 0, 0.08);

    color-scheme: light;
  }

  :host([dark]) {
    --fp-accent: #0a84ff;
    --fp-yellow: #ffd60a;
    --fp-orange: #ff9f0a;
    --fp-red: #ff453a;
    --fp-green: #30d158;
    --fp-blue: #0a84ff;
    --fp-teal: #40c8e0;

    --fp-bg: #000000;
    --fp-surface: #1c1c1e;
    --fp-surface-2: #2c2c2e;
    --fp-surface-raised: #2c2c2e;
    --fp-fill: rgba(118, 118, 128, 0.24);
    --fp-fill-strong: rgba(120, 120, 128, 0.36);
    --fp-label: #ffffff;
    --fp-label-2: rgba(235, 235, 245, 0.62);
    --fp-label-3: rgba(235, 235, 245, 0.3);
    --fp-separator: rgba(84, 84, 88, 0.55);
    --fp-scrim: rgba(0, 0, 0, 0.5);

    --fp-plan-bg: #0b0b0d;
    --fp-room: #1c1c1e;
    --fp-wall: #3a3a3c;
    --fp-grid: rgba(235, 235, 245, 0.05);
    --fp-grid-major: rgba(235, 235, 245, 0.1);
    --fp-glow: #ffcd78;
    --fp-glow-edge: #ffcd78;
    --fp-glow-edge-opacity: 0.06;
    --fp-glow-opacity: 0.3;
    --fp-press: rgba(255, 255, 255, 0.06);
    --fp-slider-fill: #f2f2f7;
    --fp-furniture: #26262a;
    --fp-furniture-soft: #2e2e33;
    --fp-furniture-line: rgba(235, 235, 245, 0.16);
    --fp-plant: #2f4a2c;
    --fp-plant-2: #3b5c36;
    --fp-rug: rgba(235, 235, 245, 0.04);
    --fp-glass: #4c8fbd;
    --fp-glass-edge: #6aa6d0;
    --fp-frame: #2c2c2e;
    --fp-frame-edge: #5a5a5e;
    --fp-window-frame: #48484a;
    --fp-door-edge: #7c7c82;
    --fp-wall-top: #636366;
    --fp-wall-side: #3a3a3c;
    --fp-furniture-side: #3a3a3e;
    --fp-door: #5a5a5e;
    --fp-door-3d: #6b655d;
    --fp-door-2d: #6b655d;
    --fp-handle: #b4b4ba;
    --fp-vac-trail: #5fa8f0;
    --fp-occupied: #3ccf9e;
    --fp-sunbeam: #ffd98a;
    --fp-air: rgba(150, 200, 245, 0.65);
    --fp-floor-opacity: 0.42;
    --fp-paint-mix: 55%;
    --fp-sky-golden: rgba(255, 150, 70, 0.14);
    --fp-sky-twilight: rgba(110, 90, 200, 0.18);
    --fp-sky-night: rgba(60, 90, 180, 0.22);
    --fp-sun-glow: rgba(255, 200, 110, 0.2);
    --fp-sun-glow-golden: rgba(255, 150, 70, 0.26);
    --fp-star: rgba(255, 255, 255, 0.9);
    --fp-cloud: rgba(200, 210, 230, 0.12);
    --fp-cloud-shadow: rgba(0, 0, 0, 0.12);
    --fp-overcast: rgba(90, 100, 120, 0.2);
    --fp-haze: rgba(120, 130, 150, 0.1);
    --fp-fog: rgba(150, 160, 180, 0.22);
    --fp-rain: rgba(170, 200, 240, 0.45);
    --fp-snow: rgba(255, 255, 255, 0.9);
    --fp-flash: rgba(220, 230, 255, 0.35);

    --fp-state-light: #ffd60a;
    --fp-state-heat: #ff9f0a;
    --fp-state-active: #0a84ff;
    --fp-state-alert: #ff9f0a;

    --fp-shadow-1: 0 1px 2px rgba(0, 0, 0, 0.5);
    --fp-shadow-2: 0 4px 14px rgba(0, 0, 0, 0.45), 0 1px 3px rgba(0, 0, 0, 0.4);
    --fp-shadow-3: 0 24px 60px rgba(0, 0, 0, 0.6), 0 6px 18px rgba(0, 0, 0, 0.4);

    color-scheme: dark;
  }

  /* less motion asked for: transitions and entrances become (almost) instant */
  @media (prefers-reduced-motion: reduce) {
    :host {
      --fp-dur-fast: 1ms;
      --fp-dur: 1ms;
      --fp-dur-slow: 1ms;
    }
  }
`;

/** Same values for JS-driven timing (gesture recognition, close animations). */
export const MOTION = { fast: 150, base: 200, slow: 250 } as const;
export const GESTURE = { holdMs: 500, doubleTapMs: 260, slopTouch: 10, slopMouse: 4 } as const;
