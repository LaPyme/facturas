#!/usr/bin/env node
// Prints the normalized text of one section of a norm published as HTML, and
// its SHA-256. Dependency-free Node, used by `.github/PRINTED_VOUCHER_SOURCES.md`.
//
//   node scripts/normative-text.mjs <file.html> <start marker> <end marker>
//
// argentina.gob.ar re-renders its pages on every request, so a checksum of the
// page itself changes while the norm does not. The checksum is taken over the
// text from the start marker up to, not including, the end marker, after
// dropping scripts, styles and tags and collapsing whitespace on every line.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const ENTITIES = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === "#") {
      const hex = entity[1] === "x" || entity[1] === "X";
      return String.fromCodePoint(
        Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10)
      );
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

export function normativeText(html, start, end) {
  const text = decodeEntities(
    html
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>|<\/tr>/gi, "\n")
      .replace(/<[^>]+>/g, "")
  );
  const from = text.indexOf(start);
  if (from === -1) {
    throw new Error(`Start marker not found: ${start}`);
  }
  const to = text.indexOf(end, from);
  if (to === -1) {
    throw new Error(`End marker not found: ${end}`);
  }
  return `${text
    .slice(from, to)
    .split("\n")
    .map((line) => line.split(/\s+/).filter(Boolean).join(" "))
    .filter(Boolean)
    .join("\n")}\n`;
}

const [file, start, end] = process.argv.slice(2);
if (!(file && start && end)) {
  console.error(
    "Usage: node scripts/normative-text.mjs <file.html> <start> <end>"
  );
  process.exit(1);
}
let section;
try {
  section = normativeText(readFileSync(file, "utf8"), start, end);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
process.stdout.write(section);
console.error(
  `sha256 ${createHash("sha256").update(section, "utf8").digest("hex")}`
);
