# Built-in guide

- Keep the manual in `guide.html`. Russian content and English translations (`#guide-translations`) belong in this same file.
- Add and update information in both languages together. Keep section IDs, illustration arrows, numbers and keyboard shortcuts consistent.
- The manual follows `grubaka.editor.language`, shared with the editor. Preserve its offline search and illustrated zoom view.
- Do not regenerate PDF documentation unless the user explicitly requests it.
- Before publishing guide changes, run `python tools/check-guide-languages.py` from the repository root.
