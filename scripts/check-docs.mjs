#!/usr/bin/env node
// Documentation checker. Dependency-free Node, run by `pnpm check:docs`.
//
// It enforces four things:
//   1. `packages/arca/README.md` is a byte-identical copy of `README.md`.
//      `pnpm docs:sync` produces it.
//   2. Every repository link in README files and every Mintlify route in
//      `docs/**/*.mdx` resolves, including heading anchors.
//   3. Every `examples/*.ts` file is linked from at least one document.
//   4. Public prose follows the repository punctuation and API-positioning
//      rules. Fenced code is excluded.
//
// `packages/arca/README.md` is a copy of the root README, so its relative
// links are resolved from the repository root: that is where npm resolves
// them from when it renders the package page.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT_README = "README.md";
const PACKAGE_README = "packages/arca/README.md";
const DOCS_DIR = "docs";
const EXAMPLES_DIR = "examples";
const EXAMPLE_BLOB_PREFIX =
  "https://github.com/LaPyme/facturas/blob/main/examples/";

const problems = [];
function fail(file, message) {
  problems.push(`${file}: ${message}`);
}

function toPosix(value) {
  return value.split(sep).join(posix.sep);
}

function listDocumentation(directory) {
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(join(ROOT, current), {
      withFileTypes: true,
    })) {
      const child = posix.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(child);
      } else if (
        entry.isFile() &&
        (entry.name.endsWith(".md") || entry.name.endsWith(".mdx"))
      ) {
        found.push(child);
      }
    }
  };
  walk(directory);
  return found.sort();
}

function exists(path) {
  try {
    statSync(join(ROOT, path));
    return true;
  } catch {
    return false;
  }
}

// Fenced code blocks are not prose: no headings and no links are read there.
function stripCodeFences(text) {
  const lines = text.split("\n");
  let fence = null;
  return lines
    .map((line) => {
      const match = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
      if (match) {
        if (fence === null) {
          fence = match[1][0];
          return "";
        }
        if (match[1][0] === fence) {
          fence = null;
          return "";
        }
      }
      return fence === null ? line : "";
    })
    .join("\n");
}

// GitHub's heading anchors: drop the markdown, lowercase, drop punctuation,
// spaces to hyphens. Accents and underscores are kept; repeats get a suffix.
function slug(heading) {
  const text = heading
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_~]/g, "");
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s+/g, "-");
}

function anchorsOf(text) {
  const anchors = new Set();
  const counts = new Map();
  for (const line of stripCodeFences(text).split("\n")) {
    const match = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) {
      continue;
    }
    const base = slug(match[1]);
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    anchors.add(seen === 0 ? base : `${base}-${seen}`);
  }
  return anchors;
}

function linksOf(text) {
  const found = [];
  const prose = stripCodeFences(text).replace(/`[^`\n]*`/g, "");
  const pattern = /!?\[[^\]]*\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
  let match = pattern.exec(prose);
  while (match !== null) {
    found.push(match[1].replace(/^<|>$/g, ""));
    match = pattern.exec(prose);
  }
  return found;
}

const files = [ROOT_README, PACKAGE_README, ...listDocumentation(DOCS_DIR)];
const contents = new Map(
  files.map((file) => [file, readFileSync(join(ROOT, file), "utf8")])
);
const anchors = new Map(
  files.map((file) => [file, anchorsOf(contents.get(file))])
);

for (const file of files.filter(
  (candidate) => candidate.endsWith(".mdx") || candidate.endsWith("README.md")
)) {
  const prose = stripCodeFences(contents.get(file));
  if (prose.includes(";")) {
    fail(file, "uses a semicolon in prose");
  }
  if (prose.includes("—")) {
    fail(file, "uses an em dash in prose");
  }
  if (/API (?:de alto nivel|exacta)/i.test(prose)) {
    fail(file, "presents the SDK as separate high-level and exact APIs");
  }
}

if (contents.get(ROOT_README) !== contents.get(PACKAGE_README)) {
  fail(
    PACKAGE_README,
    `differs from ${ROOT_README}. Run \`pnpm docs:sync\` to copy it.`
  );
}

const linkedExamples = new Set();

for (const file of files) {
  // The package README is the root README, and npm resolves its relative
  // links from the repository root.
  const base = file === PACKAGE_README ? "" : posix.dirname(file);
  for (const link of linksOf(contents.get(file))) {
    if (link.startsWith(EXAMPLE_BLOB_PREFIX)) {
      const [example] = link.slice(EXAMPLE_BLOB_PREFIX.length).split("#");
      linkedExamples.add(posix.join(EXAMPLES_DIR, example));
      continue;
    }
    if (/^[a-z][a-z\d+.-]*:/i.test(link) || link.startsWith("//")) {
      continue;
    }
    const [rawPath, anchor] = link.split("#");
    if (rawPath === "") {
      if (anchor && !anchors.get(file).has(decodeURIComponent(anchor))) {
        fail(file, `link "${link}" points to a missing heading in this file`);
      }
      continue;
    }
    const target = link.startsWith("/")
      ? resolveMintlifyRoute(rawPath)
      : toPosix(
          relative(ROOT, resolve(ROOT, base === "" ? "." : base, rawPath))
        );
    if (!target || target.startsWith("..") || !exists(target)) {
      fail(
        file,
        `link "${link}" points to a missing path "${target ?? rawPath}"`
      );
      continue;
    }
    if (target.startsWith(`${EXAMPLES_DIR}/`) && target.endsWith(".ts")) {
      linkedExamples.add(target);
    }
    if (!anchor) {
      continue;
    }
    if (!(target.endsWith(".md") || target.endsWith(".mdx"))) {
      fail(file, `link "${link}" uses an anchor on a non-documentation file`);
      continue;
    }
    if (!contents.has(target)) {
      fail(file, `link "${link}" points to an unchecked Markdown file`);
      continue;
    }
    if (!anchors.get(target).has(decodeURIComponent(anchor))) {
      fail(file, `link "${link}" points to a missing heading in "${target}"`);
    }
  }
}

function resolveMintlifyRoute(rawPath) {
  const route = decodeURIComponent(rawPath).replace(/^\/+|\/+$/g, "");
  const candidates =
    route === ""
      ? [posix.join(DOCS_DIR, "index.mdx")]
      : [
          posix.join(DOCS_DIR, `${route}.mdx`),
          posix.join(DOCS_DIR, `${route}.md`),
          posix.join(DOCS_DIR, route, "index.mdx"),
          posix.join(DOCS_DIR, route, "index.md"),
        ];
  return candidates.find(exists);
}

for (const entry of readdirSync(join(ROOT, EXAMPLES_DIR)).sort()) {
  if (!entry.endsWith(".ts")) {
    continue;
  }
  const path = posix.join(EXAMPLES_DIR, entry);
  if (!linkedExamples.has(path)) {
    fail(path, "is not linked from any document");
  }
}

if (problems.length > 0) {
  process.stderr.write(`${problems.join("\n")}\n`);
  process.stderr.write(`check:docs found ${problems.length} problem(s).\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    `check:docs ok: ${files.length} documents, ${linkedExamples.size} examples linked.\n`
  );
}
