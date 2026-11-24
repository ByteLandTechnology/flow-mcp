// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Extract live JavaScript function sources, switch cases, and object literals for mutation inference.

import { readOwn } from "./angular";
import { readBuildLabel } from "./frontend_builds";
import { runtimeState } from "./state";
import { safeFnSource } from "./store_shapes";

/** Valid JavaScript identifier pattern excluding reserved payload keys. */
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Cached function source corpus keyed by active dispatcher identity and build label. */
let cachedCorpusKey = "";
/** Cached function source strings for the active runtime. */
let cachedSources: string[] = [];

/** Bound store dispatcher reader registered by `project_store.ts`. */
export type BoundDispatcherInfo = {
  /** Bound project store service object. */
  service: object | null;
  /** Bound tile query service object. */
  tilesService: object | null;
  /** Dispatcher method on the tile query service. */
  dispatcher: unknown;
};

/** Optional callback registered by `project_store.ts` to inspect the bound store dispatcher. */
let boundDispatcherReader: (() => BoundDispatcherInfo) | null = null;

/** Registers a reader for the bound project store dispatcher so shape probes inspect it first. */
export function registerBoundDispatcherReader(reader: () => BoundDispatcherInfo): void {
  boundDispatcherReader = reader;
}

/** Collects method sources from an object and its prototype chain. */
function collectObjectMethodSources(target: unknown, out: Set<string>): void {
  if (!target || typeof target !== "object") return;
  let cur: object | null = target;
  for (let depth = 0; cur && cur !== Object.prototype && depth < 4; depth++) {
    for (const key of Object.getOwnPropertyNames(cur)) {
      if (key === "constructor") continue;
      const fn = readOwn(target, key);
      if (typeof fn === "function") {
        const src = safeFnSource(fn);
        if (src.length > 20) out.add(src);
      }
    }
    cur = Object.getPrototypeOf(cur);
  }
}

/** Collects live runtime JS sources from the bound dispatcher, store handles, and Flow namespace. */
export function runtimeMutationSources(): string[] {
  const bound = boundDispatcherReader?.() ?? {
    service: null,
    tilesService: null,
    dispatcher: undefined,
  };
  const label = readBuildLabel() ?? "unknown";
  const dispSrc = safeFnSource(bound.dispatcher);
  const qtSvc = runtimeState.lService?._qt?.tilesService;
  const qtSrc = safeFnSource(
    qtSvc && runtimeState.lService?._qt?.dispatcher
      ? readOwn(qtSvc, runtimeState.lService._qt.dispatcher)
      : undefined,
  );
  const ns = readOwn(window, "default_AiSandboxAngularFrontend");
  const nsKeys = ns && typeof ns === "object" ? Object.keys(ns) : [];
  const key = `${label}:${dispSrc.length}:${qtSrc.length}:${Boolean(runtimeState.lService)}:${nsKeys.length}`;
  if (key === cachedCorpusKey && cachedSources.length > 0) {
    return cachedSources;
  }

  const sources = new Set<string>();
  if (dispSrc) sources.add(dispSrc);
  if (qtSrc) sources.add(qtSrc);
  collectObjectMethodSources(bound.tilesService, sources);
  collectObjectMethodSources(bound.service, sources);
  if (runtimeState.lService) {
    collectObjectMethodSources(runtimeState.lService, sources);
    collectObjectMethodSources(runtimeState.lService._ap, sources);
    collectObjectMethodSources(runtimeState.lService._uo, sources);
    collectObjectMethodSources(runtimeState.lService._qt?.tilesService, sources);
    collectObjectMethodSources(runtimeState.lService._qt?.owner, sources);
    collectObjectMethodSources(runtimeState.lService.ha, sources);
    collectObjectMethodSources(runtimeState.lService.na, sources);
  }
  if (ns && typeof ns === "object") {
    for (let i = 0; i < nsKeys.length && i < 2500; i++) {
      const exp = readOwn(ns, nsKeys[i]);
      if (typeof exp === "function") {
        const src = safeFnSource(exp);
        if (src.length > 20) sources.add(src);
        const proto = readOwn(exp, "prototype");
        if (proto && typeof proto === "object") {
          collectObjectMethodSources(proto, sources);
        }
      } else if (exp && typeof exp === "object") {
        collectObjectMethodSources(exp, sources);
      }
    }
  }
  cachedCorpusKey = key;
  cachedSources = [...sources];
  return cachedSources;
}

/** Walks backward from `caseIndex` to find the variable switched on by the enclosing `switch (<var>.type)`. */
function findEnclosingSwitchVar(src: string, caseIndex: number): string {
  let depth = 0;
  for (let i = caseIndex - 1; i >= 0; i--) {
    const ch = src[i];
    if (ch === "}") {
      depth++;
    } else if (ch === "{") {
      if (depth > 0) {
        depth--;
        continue;
      }
      const header = src.slice(Math.max(0, i - 160), i);
      const sw = /switch\s*\(\s*([A-Za-z_$][A-Za-z0-9_$]*)(?:\?\.|\.)type\s*\)\s*$/.exec(header);
      if (sw) return sw[1];
    }
  }
  return "";
}

/** Extracts the body of one `case` clause up to the next sibling `case`/`default` or closing `}` of the `switch`. */
function extractCaseClauseBody(src: string, start: number): string {
  const limit = Math.min(src.length, start + 2400);
  let depth = 0;
  let quote = "";
  for (let i = start; i < limit; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      if (depth === 0) return src.slice(start, i);
      depth--;
    } else if (depth === 0 && (ch === "c" || ch === "d")) {
      const prev = i > 0 ? src[i - 1] : " ";
      if (!/[A-Za-z0-9_$]/.test(prev)) {
        const rest = src.slice(i, Math.min(limit, i + 80));
        if (/^(?:case\s*["']|default\s*:)/.test(rest)) {
          return src.slice(start, i);
        }
      }
    }
  }
  return src.slice(start, limit);
}

/** Extracts the `{ ... }` branch body immediately following an `if (<var>.type === "...")` test. */
function extractIfBranchBody(src: string, afterCond: number): string {
  const openSearchLimit = Math.min(src.length, afterCond + 120);
  let open = -1;
  for (let i = afterCond; i < openSearchLimit; i++) {
    if (src[i] === "{") {
      open = i;
      break;
    }
    if (src[i] === ";") return src.slice(afterCond, i + 1);
  }
  if (open < 0) return src.slice(afterCond, Math.min(src.length, afterCond + 400));
  const limit = Math.min(src.length, open + 2000);
  let depth = 0;
  let quote = "";
  for (let i = open; i < limit; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return src.slice(open + 1, limit);
}

/** Extracts switch-case or branch snippets following `case "<actionType>":` or `.type === "<actionType>"`. */
export function findCaseBlocks(
  sources: readonly string[],
  actionType: string,
): Array<{ block: string; actionVar: string }> {
  const escaped = actionType.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const results: Array<{ block: string; actionVar: string }> = [];
  const caseRe = new RegExp(`case\\s*["']${escaped}["']\\s*:`, "g");
  const eqRe = new RegExp(`([A-Za-z_$][A-Za-z0-9_$]*)\\.type\\s*===?\\s*["']${escaped}["']`, "g");

  for (const src of sources) {
    if (!src.includes(actionType)) continue;
    let m: RegExpExecArray | null;
    caseRe.lastIndex = 0;
    while ((m = caseRe.exec(src)) !== null) {
      const actionVar = findEnclosingSwitchVar(src, m.index);
      if (actionVar) {
        results.push({ block: extractCaseClauseBody(src, m.index + m[0].length), actionVar });
      }
    }
    eqRe.lastIndex = 0;
    while ((m = eqRe.exec(src)) !== null) {
      results.push({ block: extractIfBranchBody(src, m.index + m[0].length), actionVar: m[1] });
    }
  }
  return results;
}

/** Splits the top-level `key: value` or shorthand `key` entries of a JS object literal body. */
export function splitObjectLiteralPairs(body: string): Array<{ key: string; value: string }> {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  let quote = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
    } else if (ch === "{" || ch === "[" || ch === "(") {
      depth++;
    } else if (ch === "}" || ch === "]" || ch === ")") {
      depth--;
    } else if (ch === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));

  const out: Array<{ key: string; value: string }> = [];
  for (const raw of parts) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("...")) continue;
    let colon = -1;
    let d = 0;
    let q = "";
    for (let i = 0; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (q) {
        if (ch === "\\") i++;
        else if (ch === q) q = "";
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") q = ch;
      else if (ch === "{" || ch === "[" || ch === "(") d++;
      else if (ch === "}" || ch === "]" || ch === ")") d--;
      else if (ch === ":" && d === 0) {
        colon = i;
        break;
      }
    }
    if (colon < 0) {
      if (IDENT_RE.test(trimmed)) out.push({ key: trimmed, value: trimmed });
      continue;
    }
    const key = trimmed.slice(0, colon).trim().replace(/^["']|["']$/g, "");
    const value = trimmed.slice(colon + 1).trim();
    if (IDENT_RE.test(key)) out.push({ key, value });
  }
  return out;
}

/** Finds object literals `{ ... type: "<actionType>" ... }` and returns their top-level key-value pairs. */
export function findActionLiterals(
  sources: readonly string[],
  actionType: string,
): Array<Array<{ key: string; value: string }>> {
  const results: Array<Array<{ key: string; value: string }>> = [];
  for (const src of sources) {
    let idx = 0;
    while ((idx = src.indexOf(actionType, idx)) !== -1) {
      const typePrefix = src.slice(Math.max(0, idx - 20), idx + actionType.length + 2);
      idx += actionType.length;
      if (!/type\s*:\s*["']/.test(typePrefix)) continue;
      let open = -1;
      let depth = 0;
      for (let p = idx - actionType.length - 1; p >= Math.max(0, idx - 320); p--) {
        const ch = src[p];
        if (ch === "}" || ch === "]" || ch === ")") depth++;
        else if (ch === "{" || ch === "[" || ch === "(") {
          if (depth === 0 && ch === "{") {
            open = p;
            break;
          }
          depth--;
        }
      }
      if (open < 0) continue;
      let close = -1;
      depth = 0;
      for (let p = open; p < Math.min(src.length, open + 500); p++) {
        const ch = src[p];
        if (ch === "{" || ch === "[" || ch === "(") depth++;
        else if (ch === "}" || ch === "]" || ch === ")") {
          depth--;
          if (depth === 0 && ch === "}") {
            close = p;
            break;
          }
        }
      }
      if (close < 0) continue;
      const body = src.slice(open + 1, close);
      const pairs = splitObjectLiteralPairs(body);
      if (pairs.some((p) => p.key === "type" && p.value.replace(/["'\s]/g, "") === actionType)) {
        results.push(pairs);
      }
    }
  }
  return results;
}

/** Returns all distinct properties accessed as `<varName>.<prop>` or `<varName>?.<prop>` in `block`. */
export function propsReadOn(block: string, varName: string): string[] {
  const escaped = varName.replace(/\$/g, "\\$");
  const re = new RegExp(`\\b${escaped}(?:\\?\\.|\\.)([A-Za-z_$][A-Za-z0-9_$]*)\\b`, "g");
  const found = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    if (m[1] !== "type") found.add(m[1]);
  }
  const destructRe = new RegExp(`\\{([^{}]+)\\}\\s*=\\s*${escaped}\\b`, "g");
  while ((m = destructRe.exec(block)) !== null) {
    for (const pair of splitObjectLiteralPairs(m[1])) {
      if (pair.key !== "type") found.add(pair.key);
    }
  }
  return [...found];
}

/** Returns true when `<varName>.<prop>` is used as an array or iterable in `block`. */
export function isIteratedProp(block: string, varName: string, prop: string): boolean {
  const v = varName.replace(/\$/g, "\\$");
  const p = prop.replace(/\$/g, "\\$");
  const expr = `(?:\\b${v}(?:\\?\\.|\\.)${p}|\\(\\s*${v}(?:\\?\\.|\\.)${p}\\s*(?:\\|\\||\\?\\?)\\s*\\[\\s*\\]\\s*\\))`;
  const direct = new RegExp(
    `${expr}(?:\\?\\.|\\.)(?:map|forEach|filter|some|every|flatMap|reduce|slice|length)\\b|of\\s+${expr}\\b|Array\\.(?:from|isArray)\\s*\\(\\s*${v}(?:\\?\\.|\\.)${p}\\b`,
  );
  if (direct.test(block)) return true;
  const aliasMatch = new RegExp(
    `\\b([A-Za-z_$][A-Za-z0-9_$]*)\\s*=\\s*${v}(?:\\?\\.|\\.)${p}\\b`,
  ).exec(block);
  if (aliasMatch) {
    const alias = aliasMatch[1].replace(/\$/g, "\\$");
    return new RegExp(
      `\\b${alias}(?:\\?\\.|\\.)(?:map|forEach|filter|some|every|flatMap|reduce|slice|length)\\b|of\\s+${alias}\\b|Array\\.(?:from|isArray)\\s*\\(\\s*${alias}\\b`,
    ).test(block);
  }
  return false;
}

/** Returns true when `<varName>.<prop>` is used as a `{ resolve, reject }` completion handle in `block`. */
export function isCompletionProp(block: string, varName: string, prop: string): boolean {
  const v = varName.replace(/\$/g, "\\$");
  const p = prop.replace(/\$/g, "\\$");
  return new RegExp(`\\b${v}(?:\\?\\.|\\.)${p}(?:\\?\\.|\\.)(?:resolve|reject)\\b`).test(block);
}
