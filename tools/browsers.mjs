// The browsers roomwise supports (card and Hausregeln panel). The lowest versions follow from color-mix() in the
// styles (Chrome 111, Safari 16.2, Firefox 113) plus Safari 16.4 for module workers and the rest of the platform.
// Used as the esbuild target of both bundles and by tools/compat-check.mjs.
export const BROWSERS = { chrome: 111, edge: 111, firefox: 113, safari: 16.4 };
export const TARGET = Object.entries(BROWSERS).map(([b, v]) => `${b}${v}`);

/**
 * Features newer than some engines, as found in the built bundles: lowest version per engine (Infinity = never).
 * `guard`: the bundle may use it only behind this test (regex on the code around it).
 * `ignorable`: an unknown CSS property the browser just skips (progressive enhancement).
 * `ownRule`: a selector that must stand in a rule of its own (an unknown one drops the whole selector list).
 */
export const FEATURES = [
  { name: 'color-mix()', re: /color-mix\(/, chrome: 111, safari: 16.2, firefox: 113 },
  { name: ':has()', re: /:has\(/, chrome: 105, safari: 15.4, firefox: 121, ownRule: true },
  { name: '@container', re: /@container\b/, chrome: 105, safari: 16, firefox: 110 },
  { name: 'CSS nesting', re: /\{\s*&[\s:.[>]/, chrome: 112, safari: 16.5, firefox: 117 },
  { name: 'light-dark()', re: /light-dark\(/, chrome: 123, safari: 17.5, firefox: 120 },
  { name: 'dvh/svh/lvh', re: /\d(dvh|svh|lvh)\b/, chrome: 108, safari: 15.4, firefox: 101 },
  { name: 'text-wrap', re: /text-wrap:\s*(balance|pretty)/, chrome: 114, safari: 17.5, firefox: 121, ignorable: true },
  { name: 'field-sizing', re: /field-sizing:/, chrome: 123, safari: Infinity, firefox: Infinity, ignorable: true },
  { name: 'backdrop-filter without -webkit-', re: /(^|[^-])backdrop-filter:/, chrome: 76, safari: 18, firefox: 103, guard: /-webkit-backdrop-filter:/ },
  { name: 'structuredClone', re: /\bstructuredClone\(/, chrome: 98, safari: 15.4, firefox: 94 },
  { name: 'Array.prototype.at', re: /\.at\(-/, chrome: 92, safari: 15.4, firefox: 90 },
  { name: 'Object.hasOwn', re: /\bObject\.hasOwn\(/, chrome: 93, safari: 15.4, firefox: 92 },
  { name: 'toSorted/toReversed/with', re: /\.(toSorted|toReversed|toSpliced)\(/, chrome: 110, safari: 16, firefox: 115 },
  { name: 'Promise.withResolvers', re: /Promise\.withResolvers\(/, chrome: 119, safari: 17.4, firefox: 121 },
  { name: 'Object.groupBy', re: /\b(Object|Map)\.groupBy\(/, chrome: 117, safari: 17.4, firefox: 119 },
  { name: 'Intl.Segmenter', re: /Intl\.Segmenter\b/, chrome: 87, safari: 14.1, firefox: 125 },
  { name: 'requestIdleCallback', re: /requestIdleCallback\(/, chrome: 47, safari: Infinity, firefox: 55, guard: /['"]requestIdleCallback['"]\s*in\s*window|window\.requestIdleCallback\s*\?|typeof requestIdleCallback/ },
  { name: 'OffscreenCanvas', re: /new OffscreenCanvas\(/, chrome: 69, safari: 17, firefox: 105, guard: /typeof OffscreenCanvas/ },
  { name: 'navigator.wakeLock', re: /navigator\.wakeLock/, chrome: 84, safari: 16.4, firefox: 126, guard: /['"]wakeLock['"]\s*in\s*navigator|navigator\.wakeLock\s*\?/ },
];
