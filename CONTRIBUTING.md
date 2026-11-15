# Contributing to roomwise

Thanks for taking the time. roomwise is a small project in an early beta, so the most valuable things right now
are bug reports from real homes, reports about devices that don't behave, and feedback on how it runs on your
wall tablet. Code contributions are welcome too; please open an issue first for anything bigger than a small fix,
so we can agree on the direction before you spend an evening on it.

## Reporting a bug

Use the bug report template. The two things that help most:

1. **Diagnostics and logs.** Settings → Devices & services → *Grundriss-Karte* (or *Hausregeln*) → ⋮ →
   *Download diagnostics*, where the entry offers it. In any case: Settings → System → Logs → *Show full logs*,
   and copy the lines that mention `floorplan_card` or `house_rules`. Look through what you attach before you
   post it; you know your home better than we do.
2. **The browser console.** Open the dashboard, press F12 (or connect the tablet to a computer with remote
   debugging), reload and copy the red lines.

Say which Home Assistant version, which browser or kiosk app, and which tablet you use.

## Asking for a device

Use the device support template and tell us the integration (for example *Roborock*, *Tado*, *Shelly*) and the
entities it creates, ideally with their attributes from Developer tools → States. Without that we can only guess.

## Working on the code

The repository holds three parts:

| Folder | What it is | Language |
|---|---|---|
| `src/` | the card (Lovelace custom card, Lit 3 and three.js) | TypeScript |
| `custom_components/floorplan_card/` | the companion integration: serves the card, front door alert, walk reminders, live vacuum | Python |
| `hausregeln/` | Hausregeln: the rules integration (`custom_components/house_rules`) and its panel (`src/`) | Python, TypeScript |

Both integrations will be merged into a single `roomwise` integration later. Until then they live side by side.

### Setup

```bash
npm ci
(cd hausregeln && npm ci)
npm run build                       # card -> dist/ and custom_components/floorplan_card/frontend/
(cd hausregeln && npm run build)    # panel -> hausregeln/custom_components/house_rules/frontend/
```

### Checks before a pull request

```bash
npm run typecheck && (cd hausregeln && npm run typecheck)
node tools/tests/i18n.mjs --strict          # German and English texts complete, no hard-coded UI strings
ruff check custom_components hausregeln/custom_components hausregeln/tools
python3 hausregeln/tools/testha/test_webauthn.py
node tools/release/version.mjs              # all parts carry the same version
node tools/release/privacy-scan.mjs         # nothing private slipped in
```

CI runs the same, plus hassfest and the HACS validation.

### Testing against Home Assistant

Never test against the Home Assistant that runs your home. The integration tests use a throwaway instance in
Docker on `127.0.0.1:8124` with fake devices:

```bash
sh hausregeln/tools/testha/start.sh                      # starts the test instance with Hausregeln and fake devices
node hausregeln/tools/testha/test-engine.mjs             # rules, rooms, modes, alarm …
node hausregeln/tools/testha/test-heating.mjs            # heating plans
node tools/hr/test-hr.mjs                                # the card together with Hausregeln
```

The browser tests in `tools/tests/` drive a dashboard with a floor plan through Playwright and intercept every
service call. Point them at an instance with `HA_URL` and `HA_TOKEN` (environment or a local `.env`, which is
never committed), `FP_DASHBOARD` selects the dashboard, and `FP_LOCAL=1` serves the card from your `dist/`.
`tools/release/demo-shots.mjs` builds the demo home from `examples/demo.json` on the test instance and takes the
screenshots used in the README.

### Style

- Match the code around you: naming, comment density, the design tokens in `src/design/` and `hausregeln/src/design/`.
- Code comments in English. User-facing texts go through the translation files and stay whole sentences (no
  sentences glued together from fragments), so they can be translated.
- Keep the wall tablet in mind: no polling, no work while nothing changes, nothing that needs a fast GPU.
- Everything must work for any Home Assistant setup: missing devices, other brands, other languages.
- No personal data in code, tests, screenshots or docs. Use the demo home and neutral names.

### Commits and pull requests

Small, focused pull requests are easiest to review. Describe what changed and how you tested it; the pull request
template has a short checklist. By contributing you agree that your contribution is licensed under the
[MIT License](LICENSE).

## Code of conduct

Be kind and assume good intent. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
