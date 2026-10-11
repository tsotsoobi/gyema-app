// ===========================================================================
// Cut the site icons from the brand vector (item 8, part (e))
// ===========================================================================
//
// sharp comes via Next.js (a dependency of next) and is not a declared
// dependency of this app. Nothing is added to package.json for this script.
//
// Source: assets/brand/gyema-icon.svg, the square app icon: the hand mark
// centred on white with a 6 percent margin (see assets/brand/README.md). It
// is already the icon, so nothing is cropped.
//
// Every size is its own render from the vector, never a downscale of another
// output: the SVG is rasterised at four times the target size and reduced
// with Lanczos3, so each size is crisp. White background, no alpha: a dark
// mark on transparent vanishes in a dark tab.
//
//   app/icon2.png       512 x 512
//   app/apple-icon.png  180 x 180
//   app/favicon.ico     16 x 16 and 32 x 32, PNG-encoded entries
//
// app/icon1.svg is a byte copy of the same SVG, made here too, so modern
// browsers take the vector favicon and favicon.ico stays the fallback.
//
// The icons are numbered on purpose. With an unnumbered icon.svg and
// icon.png both in app/, Next 15 emits only one icon link (the PNG); the
// number suffix is Next's documented way to ship several icons, and it emits
// a link for each (item 8, 8.16).
//
// Run by hand: node scripts/cut-icons.mjs

import sharp from "sharp"
import { copyFileSync, readFileSync, writeFileSync } from "node:fs"

const SOURCE = "assets/brand/gyema-icon.svg"
const SUPERSAMPLE = 4
const WHITE = { r: 255, g: 255, b: 255 }

const svg = readFileSync(SOURCE)
const { width: nativeSide } = await sharp(svg).metadata()
if (!nativeSide) throw new Error("could not read the SVG size")

async function render(n) {
  // sharp rasterises an SVG at 72 dpi by default, so this density gives a
  // render SUPERSAMPLE times the target size.
  const density = (72 * n * SUPERSAMPLE) / nativeSide
  return sharp(svg, { density })
    .resize(n, n, { kernel: sharp.kernel.lanczos3, fit: "fill" })
    .flatten({ background: WHITE })
    .removeAlpha()
    .png({ compressionLevel: 9 })
    .toBuffer()
}

writeFileSync("app/icon2.png", await render(512))
writeFileSync("app/apple-icon.png", await render(180))

// ICO with PNG-encoded entries: a 6-byte header, a 16-byte directory entry
// per image, then the images.
const images = [
  [16, await render(16)],
  [32, await render(32)],
]
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0) // reserved
header.writeUInt16LE(1, 2) // type: icon
header.writeUInt16LE(images.length, 4)
let offset = 6 + 16 * images.length
const entries = images.map(([n, png]) => {
  const e = Buffer.alloc(16)
  e.writeUInt8(n, 0) // width
  e.writeUInt8(n, 1) // height
  e.writeUInt8(0, 2) // no palette
  e.writeUInt8(0, 3) // reserved
  e.writeUInt16LE(1, 4) // colour planes
  e.writeUInt16LE(32, 6) // bits per pixel
  e.writeUInt32LE(png.length, 8)
  e.writeUInt32LE(offset, 12)
  offset += png.length
  return e
})
writeFileSync("app/favicon.ico", Buffer.concat([header, ...entries, ...images.map(([, png]) => png)]))

copyFileSync(SOURCE, "app/icon1.svg")

console.log(`rendered from ${SOURCE} (${nativeSide} px at 72 dpi), ${SUPERSAMPLE}x supersampled`)
console.log("wrote app/icon1.svg, app/icon2.png, app/apple-icon.png, app/favicon.ico")
