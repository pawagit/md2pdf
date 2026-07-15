# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-07-15

### Added

- Drag-and-drop conversion: drop one or more `.md` files onto `convert.bat`
- Command line interface: `node convert.js <file.md> [file2.md ...]`
- Automatic Chrome/Edge detection via `puppeteer-core` — no bundled Chromium,
  no admin rights required
- Two built-in themes (`comfortable` and `compact`), selected in `config.json`
- Fully customizable styling through CSS variables in `style.css`
- Per-theme page margins configured in `config.json`
- GitHub-flavored Markdown support: tables, task lists, heading anchors
- Local images: relative paths in the Markdown resolve against the source
  file's folder
- Page numbers in the PDF footer, print-optimized page breaks
- Optional footer timestamp (`footer.timestamp` in `config.json`): print the
  source file's last-saved time, the PDF generation time, or both, to identify
  which version of the Markdown a PDF reflects
- PDF output written next to each source file
- Robust batch runs: a file that fails (e.g. its PDF is open in a viewer) is
  reported and skipped, the remaining files still convert
- Accepts `.md`, `.markdown`, and `.mdown` files
- `convert.bat` explains what to change when it has been moved without
  updating its converter path, instead of failing with a raw Node error
- `config.json` may be saved as UTF-8 with BOM (as Notepad does) — the BOM is
  stripped before parsing instead of silently falling back to defaults

[1.0.0]: https://github.com/pawagit/md2pdf/releases/tag/v1.0.0
