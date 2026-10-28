#!/usr/bin/env node
// Fleet-shared repo policy checks. Keep this file byte-identical across
// tanzhongyan-org templates; repo-specific settings live in scripts/repo-policy.json.
//
// Usage: node scripts/repo-policy.mjs [layout|docs|deps|drift|all]
//
//   layout  Every tracked directory matches an entry in layout.allow, and no
//           file matches layout.forbid.
//   docs    Repo paths, `make` targets and relative links cited in Markdown
//           exist; every key in .env.example is documented in the README.
//   deps    Every direct dependency has a row in the dependency ledger, and
//           every ledger row still names a real dependency.
//   drift   Each version group resolves to one value across all its files.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

const POLICY_FILE = "scripts/repo-policy.json";

function trackedFiles() {
  return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    encoding: "utf8",
  })
    .split("\0")
    .filter((f) => f && existsSync(f));
}

function read(file) {
  return readFileSync(file, "utf8");
}

// Glob subset: "*" matches within one segment, "**" matches any depth.
function globToRegex(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
    } else if (c === "*") {
      re += "[^/]*";
    } else if ("\\^$+?.()|{}[]".includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

function matchesAny(path, globs) {
  return globs.some((g) => globToRegex(g).test(path));
}

function checkLayout(policy, files) {
  const allow = policy.layout?.allow ?? [];
  const dirs = new Set();
  for (const f of files) {
    let d = dirname(f);
    while (d !== ".") {
      dirs.add(d);
      d = dirname(d);
    }
  }
  const errors = [];
  for (const d of [...dirs].sort()) {
    if (!matchesAny(d, allow)) {
      errors.push(`layout: directory '${d}/' is not in ${POLICY_FILE} layout.allow`);
    }
  }
  const forbid = policy.layout?.forbid ?? [];
  for (const f of files) {
    if (matchesAny(f, forbid)) errors.push(`layout: '${f}' matches ${POLICY_FILE} layout.forbid`);
  }
  return errors;
}

const PATH_LIKE = /^\.?[A-Za-z0-9_\-[\]().]+(\/[A-Za-z0-9_\-[\]().]+)*\/?$/;
const ROOT_FILE = /^\.?[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*\.(md|json|jsonc|ya?ml|toml|lock)$/;

// A code span is checked as a repo path when it has a slash, or names a
// root-style config or doc file such as `compose.yaml` or `README.md`.
// Module paths (`github.com/x/y`) and scoped packages (`@scope/pkg`) are skipped.
function looksLikeRepoPath(span, exists) {
  if (!PATH_LIKE.test(span) || /^\d/.test(span)) return false;
  if (span.includes("/")) {
    const first = span.split("/")[0];
    if (!first.startsWith(".") && first.includes(".") && !exists(first)) return false;
    return true;
  }
  return ROOT_FILE.test(span);
}

function makeTargets() {
  if (!existsSync("Makefile")) return new Set();
  const targets = new Set();
  for (const line of read("Makefile").split("\n")) {
    const m = line.match(/^([A-Za-z0-9_.-]+)\s*:(?!=)/);
    if (m) targets.add(m[1]);
  }
  return targets;
}

function stripFences(text) {
  return text.replace(/^(```|~~~)[\s\S]*?^\1/gm, (block) => block.replace(/[^\n]/g, " "));
}

function checkDocs(policy, files) {
  const cfg = policy.docs ?? {};
  const exclude = cfg.exclude ?? [];
  const external = cfg.externalPrefixes ?? [];
  const ignore = cfg.ignorePaths ?? [];
  const targets = makeTargets();
  const fileSet = new Set(files);
  const dirSet = new Set(files.flatMap((f) => {
    const out = [];
    let d = dirname(f);
    while (d !== ".") {
      out.push(d);
      d = dirname(d);
    }
    return out;
  }));
  const exists = (p) => {
    const clean = p.replace(/\/$/, "");
    return fileSet.has(clean) || dirSet.has(clean) || existsSync(clean);
  };
  const errors = [];

  for (const md of files.filter((f) => f.endsWith(".md") && !matchesAny(f, exclude))) {
    const raw = read(md);
    const text = stripFences(raw);
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      const where = `${md}:${i + 1}`;
      for (const [, span] of line.matchAll(/`([^`\n]+)`/g)) {
        for (const [, target] of span.matchAll(/\bmake ([a-z][a-z0-9-]*)/g)) {
          if (!targets.has(target)) errors.push(`docs: ${where} cites 'make ${target}' but Makefile has no such target`);
        }
        const candidate = span.replace(/:\d+(-\d+)?$/, "");
        if (!looksLikeRepoPath(candidate, exists)) continue;
        if (candidate.includes("<") || candidate.includes("*")) continue;
        if (external.some((p) => candidate.startsWith(p))) continue;
        if (matchesAny(candidate.replace(/\/$/, ""), ignore)) continue;
        if (!exists(candidate)) errors.push(`docs: ${where} cites '${candidate}' which does not exist`);
      }
      for (const [, href] of line.matchAll(/\]\(([^)\s]+)\)/g)) {
        if (/^([a-z]+:|#|mailto:)/.test(href)) continue;
        const target = normalize(join(dirname(md), href.split("#")[0]));
        if (target && !exists(target)) errors.push(`docs: ${where} links to '${href}' which does not exist`);
      }
    });
  }

  if (cfg.envExample && cfg.envDocumentedIn && existsSync(cfg.envExample)) {
    const doc = read(cfg.envDocumentedIn);
    for (const line of read(cfg.envExample).split("\n")) {
      const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=/);
      if (m && !doc.includes(`\`${m[1]}\``)) {
        errors.push(`docs: ${cfg.envExample} defines ${m[1]} but ${cfg.envDocumentedIn} does not document it`);
      }
    }
  }
  return errors;
}

// Minimal TOML section reader: returns { "section.name": [lines] }.
function tomlSections(text) {
  const sections = {};
  let current = "";
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "");
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) {
      current = header[1].trim();
      sections[current] ??= [];
    } else {
      (sections[current] ??= []).push(line);
    }
  }
  return sections;
}

function pep508Name(spec) {
  const m = spec.match(/^\s*["']?([A-Za-z0-9][A-Za-z0-9._-]*)/);
  return m ? m[1].toLowerCase().replace(/[._]/g, "-") : null;
}

function directDependencies(manifest) {
  const text = read(manifest);
  if (manifest.endsWith("package.json")) {
    const pkg = JSON.parse(text);
    return Object.keys({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.optionalDependencies });
  }
  if (manifest.endsWith("go.mod")) {
    const names = [];
    const body = text.replace(/^.*\/\/\s*indirect.*$/gm, "");
    for (const [, block] of body.matchAll(/^require\s*\(([\s\S]*?)^\)/gm)) {
      for (const line of block.split("\n")) {
        const m = line.trim().match(/^(\S+)\s+v\S+/);
        if (m) names.push(m[1]);
      }
    }
    for (const [, name] of body.matchAll(/^require\s+(\S+)\s+v\S+/gm)) names.push(name);
    for (const [, block] of text.matchAll(/^tool\s*\(([\s\S]*?)^\)/gm)) {
      for (const line of block.split("\n")) if (line.trim()) names.push(line.trim());
    }
    for (const [, name] of text.matchAll(/^tool\s+([^\s(]\S*)\s*$/gm)) names.push(name);
    return names;
  }
  if (manifest.endsWith("Cargo.toml")) {
    const sections = tomlSections(text);
    const names = [];
    for (const key of ["dependencies", "dev-dependencies", "build-dependencies"]) {
      for (const line of sections[key] ?? []) {
        const m = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/);
        if (m) names.push(m[1]);
      }
    }
    return names;
  }
  if (manifest.endsWith("pyproject.toml")) {
    // [project].dependencies plus every array under [dependency-groups] and
    // [project.optional-dependencies]; include-group tables carry no strings.
    const names = [];
    const sections = tomlSections(text);
    // Linear scan: find `key = [`, then collect quoted strings until the `]`
    // that closes the array outside any quote (extras like `pkg[x]` are quoted).
    const arrays = (lines, onlyKey) => {
      const body = lines.join("\n");
      for (const m of body.matchAll(/^[ \t]*([A-Za-z0-9_-]+)[ \t]*=[ \t]*\[/gm)) {
        if (onlyKey && m[1] !== onlyKey) continue;
        let quote = "";
        let current = "";
        for (let i = m.index + m[0].length; i < body.length; i++) {
          const c = body[i];
          if (quote) {
            if (c === quote) {
              const name = pep508Name(current);
              if (name) names.push(name);
              quote = "";
              current = "";
            } else {
              current += c;
            }
          } else if (c === '"' || c === "'") {
            quote = c;
          } else if (c === "]") {
            break;
          }
        }
      }
    };
    arrays(sections.project ?? [], "dependencies");
    arrays(sections["dependency-groups"] ?? []);
    arrays(sections["project.optional-dependencies"] ?? []);
    return names;
  }
  throw new Error(`deps: unsupported manifest ${manifest}`);
}

function checkDeps(policy) {
  const cfg = policy.dependencies;
  if (!cfg) return [];
  const errors = [];
  if (!existsSync(cfg.ledger)) return [`deps: ledger ${cfg.ledger} is missing`];
  const ledger = new Set();
  for (const line of read(cfg.ledger).split("\n")) {
    const m = line.match(/^\|\s*`([^`]+)`\s*\|/);
    if (m) ledger.add(m[1].toLowerCase());
  }
  const declared = new Set();
  for (const manifest of cfg.manifests) {
    for (const name of directDependencies(manifest)) {
      const key = name.toLowerCase();
      declared.add(key);
      if (!ledger.has(key)) errors.push(`deps: ${manifest} declares '${name}' but ${cfg.ledger} has no row for it`);
    }
  }
  for (const name of ledger) {
    if (!declared.has(name)) errors.push(`deps: ${cfg.ledger} lists '${name}' but no manifest declares it`);
  }
  return errors;
}

function checkDrift(policy) {
  const errors = [];
  for (const group of policy.versions ?? []) {
    const seen = [];
    for (const { file, pattern } of group.sources) {
      if (!existsSync(file)) {
        errors.push(`drift: ${group.name}: ${file} is missing`);
        continue;
      }
      const matches = [...read(file).matchAll(new RegExp(pattern, "gm"))];
      if (matches.length === 0) errors.push(`drift: ${group.name}: /${pattern}/ found nothing in ${file}`);
      for (const m of matches) seen.push({ file, value: m[1] });
    }
    const values = new Set(seen.map((s) => s.value));
    if (values.size > 1) {
      errors.push(`drift: ${group.name} disagrees: ${seen.map((s) => `${s.file}=${s.value}`).join(", ")}`);
    }
  }
  return errors;
}

function main() {
  const mode = process.argv[2] ?? "all";
  const policy = JSON.parse(read(POLICY_FILE));
  const files = trackedFiles();
  const checks = {
    layout: () => checkLayout(policy, files),
    docs: () => checkDocs(policy, files),
    deps: () => checkDeps(policy),
    drift: () => checkDrift(policy),
  };
  const selected = mode === "all" ? Object.keys(checks) : [mode];
  const errors = [];
  for (const name of selected) {
    if (!checks[name]) {
      console.error(`unknown check '${name}'; use layout|docs|deps|drift|all`);
      process.exit(2);
    }
    errors.push(...checks[name]());
  }
  for (const e of errors) console.error(e);
  console.log(`repo-policy ${selected.join(",")}: ${errors.length === 0 ? "ok" : `${errors.length} problem(s)`}`);
  process.exit(errors.length === 0 ? 0 : 1);
}

main();
