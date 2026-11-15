## What and why

<!-- What does this change, and which problem does it solve? Link the issue if there is one. -->

## How I tested it

<!-- Home Assistant version, browser/tablet, test instance or own setup (please not by experimenting on a home others rely on). -->

## Checklist

- [ ] `npm run typecheck` and `node tools/tests/i18n.mjs --strict` pass (and `cd hausregeln && npm run typecheck` if the panel changed)
- [ ] `ruff check` passes if Python changed
- [ ] New user-facing texts are whole sentences in the translation files (German and English)
- [ ] Works without the optional parts (no Hausregeln, no companion integration, missing devices)
- [ ] No personal data in code, tests, screenshots or docs (`node tools/release/privacy-scan.mjs`)
- [ ] `CHANGELOG.md` updated under *Unreleased* if users will notice the change
