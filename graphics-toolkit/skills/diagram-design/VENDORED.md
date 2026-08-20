# Vendored: diagram-design

This directory is **vendored verbatim** from
<https://github.com/cathrynlavery/diagram-design> (MIT License, Copyright (c)
2025 Cathryn Lavery), commit `5f1b6dd`, skill version `2.5.6`.

It is the diagram/vector **specialization** layered on top of this repo's
`graphics-toolkit` design system. Its Markdown skill spec and `references/`
are the authoritative design rules; its `scripts/` (Python) are **reference
implementations only** — the toolkit's own Java ≥ 25 equivalents live in
`../src/main/java` and are the ones invoked by opencode.

## What this provides

- `SKILL.md` — 28-diagram-type editorial design system (the specialization)
- `references/` — type specs, primitives, import, export, style-guide, profiles
- `assets/` — HTML templates + example renders
- `scripts/` — Python reference extractors/verifiers (self_check, geometry,
  motion, drawio/mermaid extract)

## License

MIT. See `LICENSE` (reproduced below). Upstream retains copyright; any
modifications made locally must preserve this notice.

```text
MIT License

Copyright (c) 2025 Cathryn Lavery

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
