// The operator-issued courier sign-in code: its alphabet and how what a
// courier types is normalised before it is hashed (Phase 1 item 5, 5.1).
//
// The code is minted in SQL by courier_issue_signin_code
// (db/migrations/2026-10-08_courier_signin.sql), and the database stores
// sha256 of the normalised code. The sign-in route normalises what the
// courier types the same way and sends the hash, so the two halves must
// agree to the character. tests/courier-code-parity.test.ts reads the
// alphabet and the translate() arguments out of the SQL file and checks them
// against this module.
//
// WHY ITS OWN FILE. lib/schemas.ts needs the normaliser for the sign-in body,
// and every Pioneer route imports lib/schemas.ts. lib/courier-auth.ts must
// stay out of the Pioneer routes' import graph (5.3), so the pure part lives
// here, with no imports at all.

/** Crockford base32: 0-9 and 22 letters, no I, L, O or U. The SQL literal. */
export const SIGNIN_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

/** Characters of a code once normalised. Shown as XXXXX-XXXXX. */
export const SIGNIN_CODE_LENGTH = 10

/**
 * The SQL's translate(upper(code), 'OIL- ', '011'): upper case, then O read
 * as 0, I and L read as 1, and '-' and ' ' removed.
 *
 * Callers pass ASCII only (the schema refuses anything else first), because
 * JavaScript and Postgres do not upper-case every non-ASCII letter alike.
 */
export function normaliseSigninCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1")
    .replace(/[- ]/g, "")
}

/** Ten characters, every one from the alphabet. */
export function isSigninCode(normalised: string): boolean {
  if (normalised.length !== SIGNIN_CODE_LENGTH) return false
  for (const ch of normalised) {
    if (!SIGNIN_CODE_ALPHABET.includes(ch)) return false
  }
  return true
}
