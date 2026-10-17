# Built-in guide

- Keep the manual in `guide.html`. Russian content and English translations (`#guide-translations`) belong in this same file.
- Add and update information in both languages together. Keep section IDs, illustration arrows, numbers and keyboard shortcuts consistent.
- Keep paired Russian/English screenshots in `guide-assets/` and switch them with `data-guide-ru` / `data-guide-en`. Capture the real interface in each language and update arrow coordinates when controls move.
- The manual follows `grubaka.editor.language`, shared with the editor. Preserve its offline search and illustrated zoom view.
- Do not regenerate PDF documentation unless the user explicitly requests it.
- Before publishing guide changes, run `python tools/check-guide-languages.py` from the repository root.
