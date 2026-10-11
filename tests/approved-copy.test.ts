import { describe, it, expect } from "vitest"
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import type { Listing } from "@/lib/listings"
import { UNNAMED_TRAVELLER_CAPTION, deriveStages, listingCarrierCaption } from "@/lib/tracker-stages"

// The approved copy (item 8, part (f), 8.17). Repo-wide pins that the
// retired wording does not come back, plus the strings the founder changed.

function walk(dir: string, keep: (name: string) => boolean, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, keep, out)
    else if (keep(name)) out.push(p)
  }
  return out
}

const SOURCE = [
  ...walk("app", (n) => /\.(tsx?|css)$/.test(n)),
  ...walk("components", (n) => /\.tsx?$/.test(n)),
  ...walk("lib", (n) => /\.tsx?$/.test(n)),
  ...walk("public", (n) => n.endsWith(".html")),
]

describe("retired wording, repo-wide (app/, components/, lib/, public/*.html)", () => {
  it("scans a real file set", () => {
    expect(SOURCE.length).toBeGreaterThan(50)
    expect(SOURCE).toContain(join("lib", "completion-lines.ts"))
    expect(SOURCE).toContain(join("public", "privacy.html"))
  })

  for (const [label, pattern] of [
    ['"safer way" (8.17 D1)', /safer way/i],
    ['"Phone-verified" (8.17 D2)', /Phone-verified/i],
    ['"@traveller" (8.17 D5)', /@traveller|\?\?\s*"traveller"/],
  ] as const) {
    it(`no file holds ${label}`, () => {
      const hits = SOURCE.filter((f) => pattern.test(readFileSync(f, "utf8")))
      expect(hits).toEqual([])
    })
  }

  it("no page title or metadata holds an em-dash (8.17 D7)", () => {
    const hits: string[] = []
    for (const f of SOURCE) {
      const src = readFileSync(f, "utf8")
      const values = f.endsWith(".html")
        ? [...src.matchAll(/<title>([^<]*)<\/title>/g)].map((m) => m[1])
        : [...src.matchAll(/\b(?:title|description)\s*:\s*\n?\s*"([^"]*)"/g)].map((m) => m[1])
      for (const v of values) if (v.includes("—")) hits.push(`${f}: ${v}`)
    }
    expect(hits).toEqual([])
  })
})

describe("the approved strings", () => {
  it('the root title is "Gyema: peer to peer delivery on Pi"', () => {
    expect(readFileSync("app/layout.tsx", "utf8")).toMatch(/title: "Gyema: peer to peer delivery on Pi",/)
  })

  it("the static pages title with a colon", () => {
    expect(readFileSync("public/methodology.html", "utf8")).toContain("<title>Gyema: Carbon Methodology</title>")
    expect(readFileSync("public/privacy.html", "utf8")).toContain("<title>Gyema: Privacy Policy</title>")
    expect(readFileSync("public/terms.html", "utf8")).toContain("<title>Gyema: Terms of Service</title>")
  })

  it("the courier page has its own description, with no Pi in it", () => {
    const src = readFileSync("app/courier/page.tsx", "utf8")
    const meta = src.match(/export const metadata: Metadata = \{([\s\S]*?)\n\}/)
    expect(meta).not.toBeNull()
    const description = meta![1].match(/description:\s*"([^"]*)"/)
    expect(description?.[1]).toBe("Sign in to see and take Gyema delivery jobs.")
    expect(description![1]).not.toMatch(/\bPi\b/i)
  })

  it('the sender badges read "Sender confirmed on WhatsApp"', () => {
    const sheet = readFileSync("components/guest-job-sheet.tsx", "utf8")
    expect(sheet.match(/Sender confirmed on WhatsApp/g) ?? []).toHaveLength(2)
    expect(readFileSync("components/guest-courier-card.tsx", "utf8")).toContain("Sender confirmed on WhatsApp")
    expect(readFileSync("lib/tracker-stages.ts", "utf8")).toContain(
      "caption: `Sender confirmed on WhatsApp · ${fmtDate(j.createdAt)}`"
    )
  })

  it("the courier page Account labels are the approved ones (8.17 D6)", () => {
    const src = readFileSync("app/courier/courier-panel.tsx", "utf8")
    const map = src.match(/const STATUS_LABELS: Record<string, string> = \{([\s\S]*?)\}/)
    expect(map).not.toBeNull()
    const pairs = Object.fromEntries([...map![1].matchAll(/(\w+):\s*"([^"]*)"/g)].map((m) => [m[1], m[2]]))
    expect(pairs).toEqual({
      registered: "Signed up",
      buffer: "Starter (limited jobs)",
      full: "Verified courier",
      paused: "Paused",
    })
  })
})

describe("the package carrier with no matched username (8.17 D5)", () => {
  function pkg(matchedWithUsername: string | null | undefined): Listing {
    return {
      kind: "package",
      status: "matched",
      postedByUsername: "poster_fixture",
      matchedWithUsername,
      fromCity: "Osu",
      toCity: "Madina",
      createdAt: "2026-10-01T00:00:00Z",
    } as unknown as Listing
  }

  it('reads "A traveller is carrying it", with no "@"', () => {
    for (const m of [null, undefined, ""]) {
      const caption = listingCarrierCaption(pkg(m))
      expect(caption, String(m)).toBe("A traveller is carrying it")
      expect(caption).not.toContain("@")
    }
    expect(UNNAMED_TRAVELLER_CAPTION).toBe("A traveller is carrying it")
    expect(deriveStages(pkg(null)).find((s) => s.label === "Accepted")!.caption).toBe("A traveller is carrying it")
  })

  it("is unchanged with a username", () => {
    expect(listingCarrierCaption(pkg("matched_fixture"))).toBe("@matched_fixture is carrying it")
  })
})

describe("markers", () => {
  it("no COPY DRAFT marker is left in the code", () => {
    const files = [...SOURCE, ...walk("scripts", (n) => /\.m?js$/.test(n)), "middleware.ts"].filter((f) => existsSync(f))
    expect(files.filter((f) => readFileSync(f, "utf8").includes("COPY DRAFT"))).toEqual([])
  })

  it('what stays open is marked "COPY: later (8.17)"', () => {
    expect(readFileSync("app/layout.tsx", "utf8")).toMatch(/COPY: later \(8\.17\)[^\n]*\n\s*themeColor:/)
    expect(readFileSync("lib/guest-accept-message.ts", "utf8")).toContain("COPY: later (8.17)")
    expect(readFileSync("app/courier/courier-jobs.tsx", "utf8")).toMatch(/COPY: later \(8\.17\)[\s\S]*?const ACCEPT_ERRORS/)
    expect(readFileSync("lib/completion-lines.ts", "utf8")).toMatch(/COPY: later \(8\.17\)[\s\S]*?GUEST_LINE_SENDER_AND_CODE/)
  })
})
