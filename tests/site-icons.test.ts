import { describe, it, expect } from "vitest"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

// The site icons (item 8, part (e), 8.4 and 8.10 decision 6). Next's file
// convention reads app/, so the icons live there and Next emits the links.
// They are cut from assets/brand/gyema-icon.svg by scripts/cut-icons.mjs; the
// v0 template's icons and placeholders are gone from public/.

function pngInfo(buf: Buffer) {
  expect(buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true)
  expect(buf.subarray(12, 16).toString("ascii")).toBe("IHDR")
  // Colour type 2 is RGB with no alpha channel; 6 would be RGBA.
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), colourType: buf.readUInt8(25) }
}

const REMOVED = [
  "apple-icon.png",
  "icon-dark-32x32.png",
  "icon-light-32x32.png",
  "icon.svg",
  "placeholder-logo.png",
  "placeholder-logo.svg",
  "placeholder-user.jpg",
  "placeholder.jpg",
  "placeholder.svg",
]

const SVGS = ["assets/brand/gyema-icon.svg", "assets/brand/gyema-hand-mark.svg"]

describe("the icons under app/", () => {
  it("app/icon2.png is 512 x 512, RGB with no alpha", () => {
    expect(pngInfo(readFileSync("app/icon2.png"))).toEqual({ width: 512, height: 512, colourType: 2 })
  })

  it("app/apple-icon.png is 180 x 180, RGB with no alpha", () => {
    expect(pngInfo(readFileSync("app/apple-icon.png"))).toEqual({ width: 180, height: 180, colourType: 2 })
  })

  it("app/favicon.ico holds a 16 and a 32, each a PNG of that size with no alpha", () => {
    const ico = readFileSync("app/favicon.ico")
    expect(ico.readUInt16LE(0)).toBe(0)
    expect(ico.readUInt16LE(2)).toBe(1)
    const count = ico.readUInt16LE(4)
    expect(count).toBe(2)
    const sizes: number[] = []
    for (let i = 0; i < count; i++) {
      const e = 6 + 16 * i
      const declared = ico.readUInt8(e)
      expect(ico.readUInt8(e + 1)).toBe(declared)
      const length = ico.readUInt32LE(e + 8)
      const offset = ico.readUInt32LE(e + 12)
      const png = ico.subarray(offset, offset + length)
      expect(pngInfo(png)).toEqual({ width: declared, height: declared, colourType: 2 })
      sizes.push(declared)
    }
    expect(sizes.sort((a, b) => a - b)).toEqual([16, 32])
  })

  it("app/icon1.svg is a byte copy of assets/brand/gyema-icon.svg", () => {
    expect(readFileSync("app/icon1.svg").equals(readFileSync("assets/brand/gyema-icon.svg"))).toBe(true)
  })

  // With an unnumbered icon.svg and icon.png both in app/, Next 15 emits only
  // the PNG link (seen on a local production build of both hosts, 8.16). The
  // numbered names are Next's documented way to ship both.
  it("app/ never holds both an unnumbered icon.svg and icon.png", () => {
    expect(existsSync("app/icon.svg") && existsSync("app/icon.png")).toBe(false)
  })
})

describe("the brand SVGs are safe to serve", () => {
  for (const f of SVGS) {
    it(`${f} holds only svg, rect and path, with no script, style, link or handler`, () => {
      const src = readFileSync(f, "utf8")
      const elements = new Set((src.match(/<\s*([a-zA-Z][\w:-]*)/g) ?? []).map((t) => t.replace(/^<\s*/, "")))
      for (const el of elements) expect(["svg", "rect", "path"], el).toContain(el)
      expect(src).not.toMatch(/<\s*[!?]/) // no doctype, entity, CDATA or processing instruction
      expect(src).not.toMatch(/script/i)
      expect(src).not.toMatch(/<\s*style|\sstyle\s*=/i)
      expect(src).not.toMatch(/href/i)
      expect(src).not.toMatch(/\son[a-z]+\s*=/i)
      expect(src).not.toMatch(/url\(|@import|data:|javascript:/i)
      // The only URL is the SVG namespace, an identifier that is never fetched.
      expect(src.match(/[a-z]+:\/\/[^"'\s)]+/gi) ?? []).toEqual(["http://www.w3.org/2000/svg"])
    })
  }
})

describe("public/", () => {
  it("none of the v0 template files remains", () => {
    for (const f of REMOVED) expect(existsSync(join("public", f)), f).toBe(false)
  })

  it("keeps gyema-hand.png", () => {
    expect(existsSync("public/gyema-hand.png")).toBe(true)
  })

  it("no source file references a removed file", () => {
    const roots = ["app", "components", "hooks", "lib", "public", "scripts"]
    const rootFiles = ["middleware.ts", "next.config.mjs", "vercel.json", "components.json"]
    const files: string[] = [...rootFiles]
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.(tsx?|mjs|js|css|html|json|txt)$/.test(name)) files.push(p)
      }
    }
    for (const r of roots) if (existsSync(r)) walk(r)

    for (const f of files) {
      const src = readFileSync(f, "utf8")
      for (const removed of REMOVED) {
        // middleware.ts names icon.svg and apple-icon.png as URL paths in its
        // matcher's exclusion list: apple-icon.png now covers
        // app/apple-icon.png, and icon.svg is a dead entry, left alone
        // (8.16). The cutting script names app/apple-icon.png as an output
        // and explains why icon.svg is not used. Neither refers to public/.
        const urlPath = removed === "icon.svg" || removed === "apple-icon.png"
        if (urlPath && (f === "middleware.ts" || f === join("scripts", "cut-icons.mjs"))) {
          expect(src, f).not.toContain(`public/${removed}`)
          continue
        }
        expect(src, `${f} names ${removed}`).not.toContain(removed)
      }
    }
  })
})
