import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import {
  SIGNIN_CODE_ALPHABET,
  SIGNIN_CODE_LENGTH,
  isSigninCode,
  normaliseSigninCode,
} from "@/lib/courier-code"
import { CourierSignInBody } from "@/lib/schemas"

// The sign-in code is minted and hashed in SQL and typed, normalised and
// hashed again in TypeScript. If the two disagree by one character, a real
// code never matches and the courier is told "That code did not work".
//
// So the alphabet, the code length and the normalisation are read OUT OF the
// migration file here, not copied into this test, and compared with
// lib/courier-code.ts. An edit to either side alone fails.

const sql = readFileSync("db/migrations/2026-10-08_courier_signin.sql", "utf8")

function one(re: RegExp, what: string): RegExpExecArray {
  const all = [...sql.matchAll(new RegExp(re.source, "g"))]
  expect(all.length, `${what} should appear exactly once in the statements`).toBe(1)
  return all[0]
}

const sqlAlphabet = one(/c_alphabet\s+constant text := '([^']*)';/, "the alphabet")[1]

// Every translate() in the file, normalised or stored: they must all agree.
const translates = [...sql.matchAll(/translate\(upper\((?:v_code|code)\), '([^']*)', '([^']*)'\)/g)]
const [, sqlFrom, sqlTo] = translates[0] ?? []

// The byte positions the SQL draws characters from.
const sqlBytes = one(/foreach v_i in array array\[([0-9, ]+)\] loop/, "the byte list")[1]
  .split(",")
  .map((n) => Number(n.trim()))

/** Postgres translate(): each from-character maps to the to-character at its index, or is deleted. */
function pgTranslate(s: string, from: string, to: string): string {
  let out = ""
  for (const ch of s) {
    const i = from.indexOf(ch)
    if (i === -1) out += ch
    else if (i < to.length) out += to[i]
  }
  return out
}

/** The SQL's normalisation, for ASCII input, from the arguments in the file. */
function sqlNormalise(raw: string): string {
  return pgTranslate(raw.toUpperCase(), sqlFrom, sqlTo)
}

describe("the code alphabet and normalisation agree with the SQL", () => {
  it("finds the translate arguments, and every translate in the file uses the same ones", () => {
    expect(translates.length).toBeGreaterThanOrEqual(2)
    for (const t of translates) {
      expect([t[1], t[2]]).toEqual([sqlFrom, sqlTo])
    }
  })

  it("has the same alphabet, 32 distinct characters with no I, L, O or U", () => {
    expect(SIGNIN_CODE_ALPHABET).toBe(sqlAlphabet)
    expect(new Set(SIGNIN_CODE_ALPHABET).size).toBe(32)
    expect(SIGNIN_CODE_ALPHABET).not.toMatch(/[ILOU]/)
  })

  it("has the same length: one character per byte the SQL draws", () => {
    expect(sqlBytes).toHaveLength(SIGNIN_CODE_LENGTH)
    // The version and variant bytes of a v4 UUID are never used.
    expect(sqlBytes).not.toContain(6)
    expect(sqlBytes).not.toContain(8)
  })

  it("normalises every ASCII character the schema admits exactly as the SQL does", () => {
    const admitted = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz -"
    for (const ch of admitted) {
      expect(normaliseSigninCode(ch), JSON.stringify(ch)).toBe(sqlNormalise(ch))
    }
    for (const sample of ["7k3qm-9xd2p", "OIL01 ab-2cd", " o0 i1 l1 ", "--  --", "abcde-fghij"]) {
      expect(normaliseSigninCode(sample), sample).toBe(sqlNormalise(sample))
    }
  })

  it("accepts every code the SQL can mint: any alphabet characters, with the dash it adds", () => {
    for (let i = 0; i < 200; i++) {
      let raw = ""
      for (let j = 0; j < SIGNIN_CODE_LENGTH; j++) {
        raw += SIGNIN_CODE_ALPHABET[Math.floor(Math.random() * 32)]
      }
      const shown = `${raw.slice(0, 5)}-${raw.slice(5)}`
      expect(normaliseSigninCode(shown)).toBe(raw)
      expect(isSigninCode(normaliseSigninCode(shown))).toBe(true)
      const parsed = CourierSignInBody.safeParse({ code: shown.toLowerCase() })
      expect(parsed.success && parsed.data.code).toBe(raw)
    }
  })
})
