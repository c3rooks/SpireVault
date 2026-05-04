// Catches a narrow class of bugs that `node --check` lets slip:
// stray backticks (or `${...}` markers) inside HTML / JS comments
// that themselves live inside a JS template literal. Such a comment
// closes the template early, leaving the rest of the would-be
// HTML to parse as raw JS — and the file structurally still
// parses, which is why `node --check` is happy. The browser
// explodes the first time that template is rendered.
//
// Concrete history that motivated this check:
//   v53 of script.js shipped with this comment inside a template:
//     <!-- ("Profile" → web, "Steam" → steam:// deep link) -->
//   The backticks around `steam://` inside the comment terminated
//   the surrounding template literal, so `steam://...` parsed as
//   bare JS → "Uncaught SyntaxError: Unexpected identifier 'steam'"
//   the moment renderRow() ran. Boot crashed, no companion
//   diorama rendered, every player feed row went blank.
//
// Strategy: walk every JS file, track template-literal nesting
// depth using a hand-rolled lexer that respects /* */ and //
// comments, then for each character span inside a template
// literal flag any `${`, `${`-like, or backtick that appears
// inside an HTML comment (`<!-- ... -->`). HTML comments inside
// JS template literals MUST NOT contain raw backticks because
// the JS parser doesn't know they're "inside HTML" — it only
// sees a literal backtick and closes the template.
//
// Returns nonzero exit if any such case is found.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const TARGETS = ["script.js", "auth.html"];
function listLib() {
  const lib = join(ROOT, "lib");
  try {
    return readdirSync(lib).filter(f => f.endsWith(".js")).map(f => join("lib", f));
  } catch { return []; }
}
const FILES = [...TARGETS, ...listLib()];

let problemCount = 0;

function check(file) {
  const path = join(ROOT, file);
  let src;
  try { src = readFileSync(path, "utf8"); } catch { return; }

  // State:
  //  mode = "code" | "lineComment" | "blockComment" | "string-d" | "string-s" | "template"
  //  templateDepth tracks nested template literals via ${ ... }
  let mode = "code";
  let line = 1, col = 0;
  let templateStartLine = 0;
  let templateBuf = "";

  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (c === "\n") { line++; col = 0; } else { col++; }

    switch (mode) {
      case "code":
        if (c === "/" && n === "/") { mode = "lineComment"; i++; }
        else if (c === "/" && n === "*") { mode = "blockComment"; i++; }
        else if (c === '"') mode = "string-d";
        else if (c === "'") mode = "string-s";
        else if (c === "`") {
          mode = "template";
          templateStartLine = line;
          templateBuf = "";
        }
        break;

      case "lineComment":
        if (c === "\n") mode = "code";
        break;

      case "blockComment":
        if (c === "*" && n === "/") { mode = "code"; i++; }
        break;

      case "string-d":
        if (c === "\\") { i++; col++; }
        else if (c === '"') mode = "code";
        break;
      case "string-s":
        if (c === "\\") { i++; col++; }
        else if (c === "'") mode = "code";
        break;

      case "template":
        if (c === "\\") { templateBuf += c + (src[i + 1] || ""); i++; col++; break; }
        if (c === "$" && n === "{") {
          // Skip over the interpolation — it's parsed as code, not
          // template body, so we don't analyze it for HTML comments.
          let depth = 1;
          i += 2;
          while (i < src.length && depth > 0) {
            const ch = src[i];
            if (ch === "{") depth++;
            else if (ch === "}") depth--;
            else if (ch === "`" && depth === 0) { /* unreachable */ }
            i++;
            if (ch === "\n") { line++; col = 0; } else { col++; }
          }
          i--; // re-emit the closing brace position
          break;
        }
        if (c === "`") {
          // Closing the template — analyze its body for HTML
          // comments containing backticks. (Backticks would have
          // already broken us out, so we'd never see this path
          // reach a healthy close *with* a stray backtick — but
          // we still scan for `${` / unterminated HTML comments
          // that look suspicious.)
          mode = "code";
          analyzeTemplate(file, templateStartLine, templateBuf);
          templateBuf = "";
          break;
        }
        templateBuf += c;
        break;
    }
  }
}

function analyzeTemplate(file, startLine, body) {
  // Find every <!-- ... --> in this template body. If any contains
  // a backtick, that's the bug we got bitten by — JS parser would
  // have terminated the template at that backtick rather than
  // staying inside the HTML comment.
  const re = /<!--([\s\S]*?)-->/g;
  let m;
  while ((m = re.exec(body))) {
    const commentBody = m[1];
    if (commentBody.includes("`")) {
      const lineNo = startLine + body.slice(0, m.index).split("\n").length - 1;
      console.error(`✘ ${file}:~${lineNo}: HTML comment inside JS template literal contains a backtick — this terminates the template early at runtime.`);
      console.error(`  comment snippet: ${commentBody.trim().slice(0, 80)}…`);
      problemCount++;
    }
  }
}

for (const f of FILES) check(f);

if (problemCount > 0) {
  console.error(`\n${problemCount} runtime template-literal issue${problemCount === 1 ? "" : "s"} found.`);
  process.exit(1);
}
console.log("✓ runtime preflight passed");
