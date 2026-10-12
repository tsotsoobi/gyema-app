import { readFileSync, readdirSync, statSync, existsSync } from "node:fs"
import { join } from "node:path"

// What a reader of the app can see, for the em-dash pin
// (tests/approved-copy.test.ts). Comments are developer text and are
// blanked; everything else in a .ts or .tsx file under app/ or components/
// (string literals, template literals, JSX text) and every .html page under
// public/ outside its comments is treated as user-facing. Blanking keeps the
// newlines, so a hit keeps its line number.

// Words after which a quote opens a string, though the character before it
// is a letter.
const KEYWORDS_BEFORE_A_STRING = new Set([
  "return", "from", "case", "typeof", "in", "of", "else", "yield", "await", "export", "default", "throw", "import",
])

/**
 * Whether a quote at position i opens a string literal, or is a character in
 * JSX text. JSX text follows a word ("won't"); a string literal follows
 * punctuation, the start of a line, or one of a few keywords. A backtick
 * always opens a template.
 */
function opensString(src: string, i: number): boolean {
  if (src[i] === "`") return true
  let j = i - 1
  while (j >= 0 && (src[j] === " " || src[j] === "\t")) j--
  if (j < 0 || src[j] === "\n" || src[j] === "\r") return true
  if (!/[A-Za-z0-9_$]/.test(src[j])) return true
  let k = j
  while (k >= 0 && /[A-Za-z0-9_$]/.test(src[k])) k--
  return KEYWORDS_BEFORE_A_STRING.has(src.slice(k + 1, j + 1))
}

/**
 * A .ts or .tsx source with its // and block comments replaced by spaces.
 *
 * A small scanner with a mode stack: code, a quoted string, or a template
 * literal. Inside a template, ${ returns to code until its matching }, so a
 * template nested in a template expression is followed correctly.
 */
export function stripTsComments(src: string): string {
  let out = ""
  let i = 0
  // Each code frame counts the braces opened inside it; a template's ${
  // pushes a code frame that ends at the } closing it.
  type Frame = { mode: "code"; braces: number; inTemplate: boolean } | { mode: "string"; quote: string } | { mode: "template" }
  const stack: Frame[] = [{ mode: "code", braces: 0, inTemplate: false }]
  while (i < src.length) {
    const top = stack[stack.length - 1]
    const c = src[i]
    const next = src[i + 1]
    if (top.mode === "string" || top.mode === "template") {
      out += c
      if (c === "\\") {
        out += next ?? ""
        i += 2
        continue
      }
      if (top.mode === "string" && (c === top.quote || c === "\n")) stack.pop()
      else if (top.mode === "template" && c === "`") stack.pop()
      else if (top.mode === "template" && c === "$" && next === "{") {
        out += "{"
        i += 2
        stack.push({ mode: "code", braces: 0, inTemplate: true })
        continue
      }
      i++
      continue
    }
    if (c === "{") top.braces++
    if (c === "}") {
      if (top.inTemplate && top.braces === 0) {
        stack.pop()
        out += c
        i++
        continue
      }
      top.braces--
    }
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") {
        out += " "
        i++
      }
      continue
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2)
      const stop = end === -1 ? src.length : end + 2
      out += src.slice(i, stop).replace(/[^\n]/g, " ")
      i = stop
      continue
    }
    if (c === "`") stack.push({ mode: "template" })
    else if ((c === '"' || c === "'") && opensString(src, i)) stack.push({ mode: "string", quote: c })
    out += c
    i++
  }
  return out
}

/** An .html page with its <!-- --> comments, and comments in <style>, blanked. */
export function stripHtmlComments(src: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, " ")
  return src
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/<style[\s\S]*?<\/style>/g, (block) => block.replace(/\/\*[\s\S]*?\*\//g, blank))
}

function walk(dir: string, keep: (name: string) => boolean, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, keep, out)
    else if (keep(name)) out.push(p)
  }
  return out
}

/** Every file the pin reads, with forward slashes. */
export function userFacingFiles(): string[] {
  return [
    ...walk("app", (n) => /\.tsx?$/.test(n)),
    ...walk("components", (n) => /\.tsx?$/.test(n)),
    ...walk("public", (n) => n.endsWith(".html")),
  ].map((f) => f.replace(/\\/g, "/"))
}

/** Each em-dash in user-facing text, as file:line and the trimmed line. */
export function emDashHits(char = "\u2014"): Array<{ file: string; line: number; text: string }> {
  const hits: Array<{ file: string; line: number; text: string }> = []
  for (const file of userFacingFiles()) {
    const raw = readFileSync(file, "utf8")
    const visible = file.endsWith(".html") ? stripHtmlComments(raw) : stripTsComments(raw)
    const rawLines = raw.split(/\r?\n/)
    visible.split(/\r?\n/).forEach((line, i) => {
      const n = line.split(char).length - 1
      for (let k = 0; k < n; k++) hits.push({ file, line: i + 1, text: rawLines[i].trim() })
    })
  }
  return hits
}
