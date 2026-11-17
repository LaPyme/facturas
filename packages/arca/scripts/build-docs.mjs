#!/usr/bin/env node
// Copies the documentation and the agent skill into the package, so an agent
// reads the docs of the installed version from node_modules/facturas/ instead
// of the site, which always describes the latest release.
//
//   docs/llms.txt                 the index, with links to the local pages
//   docs/<section>/<page>.md      every page in the docs.json navigation
//   skills/facturas/SKILL.md      the skill, byte for byte
//
// A page's `<PromptText prompt={name} />` becomes a text block with the
// constant of that name in docs/snippets/prompts.jsx.
//
// The pages are Mintlify MDX. The few components they use outside code are
// turned into plain Markdown. Any other component fails the build, so a new
// one never ships as raw JSX.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = resolve(PACKAGE, "../..");
const SOURCE_DOCS = join(ROOT, "docs");
const OUT_DOCS = join(PACKAGE, "docs");
const OUT_SKILLS = join(PACKAGE, "skills");
const SITE_URL = "https://facturas-sdk.dev";
const PROMPTS = join(SOURCE_DOCS, "snippets", "prompts.jsx");

const CALLOUTS = new Set(["Info", "Note", "Tip", "Warning", "Check"]);
const DROPPED = new Set(["CodeGroup", "Columns"]);

function navigationPages() {
  const config = JSON.parse(
    readFileSync(join(SOURCE_DOCS, "docs.json"), "utf8")
  );
  const pages = [];
  for (const group of config.navigation.groups) {
    for (const page of group.pages) {
      if (typeof page !== "string") {
        throw new Error(
          `Nested navigation is not supported: ${JSON.stringify(page)}`
        );
      }
      // The home page is a custom landing, not documentation.
      if (page !== "index") {
        pages.push(page);
      }
    }
  }
  return pages;
}

function parseFrontmatter(source, page) {
  const match = source.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) {
    throw new Error(`${page}.mdx has no frontmatter.`);
  }
  const field = (name) => {
    const line = match[1].match(new RegExp(`^${name}:\\s*"(.*)"\\s*$`, "m"));
    return line ? line[1] : undefined;
  };
  const title = field("title");
  if (!title) {
    throw new Error(`${page}.mdx has no title.`);
  }
  return {
    title,
    description: field("description"),
    body: source.slice(match[0].length),
  };
}

function readPrompts() {
  const source = readFileSync(PROMPTS, "utf8");
  return new Map(
    [...source.matchAll(/^export const (\w+) = `([^`]*)`;$/gm)].map(
      ([, name, text]) => [name, text]
    )
  );
}

function attribute(tag, name) {
  return tag.match(new RegExp(`${name}="([^"]*)"`))?.[1];
}

// `/guides/invoices#x` becomes `../guides/invoices.md#x`, relative to the page.
function localizeLinks(line, page, pages) {
  return line.replace(/\]\((\/[^)\s]*)\)/g, (_whole, target) => {
    const [path, hash] = target.split("#");
    const route = path.slice(1);
    if (pages.includes(route)) {
      const relative = posix.relative(posix.dirname(page), route);
      return `](${relative}.md${hash ? `#${hash}` : ""})`;
    }
    return `](${SITE_URL}${target})`;
  });
}

function dedent(lines) {
  const indents = lines
    .filter((line) => line.trim())
    .map((line) => line.match(/^ */)[0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return lines.map((line) => line.slice(cut));
}

// One page's conversion state: the open code fence, callout and block.
function createConverter(page, pages, prompts) {
  const out = [];
  const state = { fence: null, callout: null, block: null };
  const link = (text) => localizeLinks(text, page, pages);
  const push = (line) => out.push(state.callout ? `> ${line}` : line);

  function closeBlock() {
    const { kind, tag, lines } = state.block;
    const content = dedent(lines).join("\n").trim();
    if (kind === "Card") {
      const text = content.replace(/\s*\n\s*/g, " ");
      out.push(
        `- [${attribute(tag, "title")}](${attribute(tag, "href")}): ${link(text)}`
      );
    }
    state.block = null;
  }

  function openCallout(name, trimmed, where) {
    const inline = trimmed.match(new RegExp(`^<${name}>(.*)</${name}>$`));
    if (inline) {
      out.push(`> ${link(inline[1].trim())}`);
      return;
    }
    if (trimmed !== `<${name}>`) {
      throw new Error(
        `${where}: put the content of <${name}> on its own lines.`
      );
    }
    state.callout = name;
  }

  function component(name, trimmed, where) {
    const closing = trimmed.startsWith("</");
    if (DROPPED.has(name)) {
      return;
    }
    if (CALLOUTS.has(name)) {
      if (closing) {
        state.callout = null;
      } else {
        openCallout(name, trimmed, where);
      }
      return;
    }
    if (name === "Accordion") {
      if (!closing) {
        out.push(`#### ${attribute(trimmed, "title")}`);
      }
      return;
    }
    if (name === "Card" && !closing) {
      state.block = { kind: name, tag: trimmed, lines: [] };
      return;
    }
    if (name === "PromptText") {
      const key = trimmed.match(/prompt=\{(\w+)\}/)?.[1];
      if (!prompts.has(key)) {
        throw new Error(
          `${where}: ${key} is not a prompt in docs/snippets/prompts.jsx.`
        );
      }
      out.push("```text", prompts.get(key), "```");
      return;
    }
    throw new Error(
      `${where}: <${name}> has no Markdown conversion. Add one in packages/arca/scripts/build-docs.mjs.`
    );
  }

  function line(raw, where) {
    const trimmed = raw.trim();
    const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/);
    if (state.fence) {
      if (fenceMatch && trimmed.startsWith(state.fence)) {
        state.fence = null;
      }
      push(raw);
      return;
    }
    if (state.block) {
      if (trimmed === `</${state.block.kind}>`) {
        closeBlock();
      } else {
        state.block.lines.push(raw);
      }
      return;
    }
    if (fenceMatch) {
      state.fence = fenceMatch[1];
      push(raw);
      return;
    }
    if (/^import .* from "\/snippets\//.test(trimmed)) {
      return;
    }
    const tag = trimmed.match(/^<\/?([A-Z][A-Za-z]*)\b/);
    if (tag) {
      component(tag[1], trimmed, where);
      return;
    }
    const text = link(raw);
    if (state.callout) {
      out.push(text.trim() ? `> ${text.trim()}` : ">");
    } else {
      out.push(text);
    }
  }

  function finish() {
    const open = state.fence
      ? "code fence"
      : (state.callout ?? state.block?.kind);
    if (open) {
      throw new Error(`${page}.mdx: unclosed ${open}.`);
    }
    return out;
  }

  return { line, finish };
}

function convertPage(page, pages, prompts) {
  const source = readFileSync(join(SOURCE_DOCS, `${page}.mdx`), "utf8");
  const { title, description, body } = parseFrontmatter(source, page);
  const converter = createConverter(page, pages, prompts);
  body.split("\n").forEach((raw, index) => {
    converter.line(raw, `${page}.mdx:${index + 1}`);
  });
  const out = [`# ${title}`, "", ...(description ? [description, ""] : [])];
  out.push(...converter.finish());
  return `${out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()}\n`;
}

const HOW_TO_READ_SITE =
  "Cada página se puede leer en Markdown agregando `.md` a la URL, por ejemplo https://facturas-sdk.dev/guides/invoices.md. El texto completo de todas las páginas está en [llms-full.txt](https://facturas-sdk.dev/llms-full.txt).";
const HOW_TO_READ_PACKAGE =
  "Esta copia viene con el paquete y corresponde a la versión instalada. Cada página está en Markdown en este mismo directorio, con la ruta del enlace. El sitio, https://facturas-sdk.dev, describe siempre la última versión.";

function convertIndex(pages) {
  let text = readFileSync(join(SOURCE_DOCS, "llms.txt"), "utf8");
  if (!text.includes(HOW_TO_READ_SITE)) {
    throw new Error(
      "docs/llms.txt changed its reading section. Update HOW_TO_READ_SITE in packages/arca/scripts/build-docs.mjs."
    );
  }
  text = text.replace(HOW_TO_READ_SITE, HOW_TO_READ_PACKAGE);
  return text.replace(
    /https:\/\/facturas-sdk\.dev\/([^)\s#]+)\.md/g,
    (whole, route) => (pages.includes(route) ? `${route}.md` : whole)
  );
}

const pages = navigationPages();
const prompts = readPrompts();
rmSync(OUT_DOCS, { recursive: true, force: true });
rmSync(OUT_SKILLS, { recursive: true, force: true });

for (const page of pages) {
  const target = join(OUT_DOCS, `${page}.md`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, convertPage(page, pages, prompts));
}
writeFileSync(join(OUT_DOCS, "llms.txt"), convertIndex(pages));

mkdirSync(join(OUT_SKILLS, "facturas"), { recursive: true });
writeFileSync(
  join(OUT_SKILLS, "facturas", "SKILL.md"),
  readFileSync(join(ROOT, "skills", "facturas", "SKILL.md"))
);

console.log(
  `Copied ${pages.length} pages, llms.txt and the skill into the package.`
);
