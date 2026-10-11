# Brand assets

- `gyema-hand-mark.svg`: the brand master. The hand mark only, on a transparent background.
- `gyema-icon.svg`: the square app icon. The same mark centred on white, with a 6 percent margin.
- `gyema-logo-1024.jpg`: the original raster (1024 x 1024: mark, wordmark and tagline). The SVGs were traced from it.

The site icons are cut from `gyema-icon.svg`: `app/icon1.svg` (a byte copy), `app/icon2.png` (512), `app/apple-icon.png` (180) and `app/favicon.ico` (16 and 32). To recut them after changing the SVG, run `node scripts/cut-icons.mjs` from the repository root.

The icons are numbered on purpose. With an unnumbered `icon.svg` and `icon.png` both in `app/`, Next 15 emits only the PNG link.
