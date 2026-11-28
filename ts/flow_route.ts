// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Parse Google Flow URL prefixes, workspace route allowlists, and request identifiers.

/** Parsed prefix and normalized route details of a Flow pathname. */
export interface StrippedFlowPath {
  /** Active prefix starting with `/` when present, keeping original case. */
  prefix: string;
  /** Normalized lowercase route starting with `/` without trailing slashes. */
  route: string;
  /** True when `/fx/tools/flow` appears among the stripped prefixes. */
  hasLabsFlowPrefix: boolean;
  /** Account index extracted from `/u/<digits>` when present. */
  pathAuthuser: string | null;
}

/** Reserved Flow top-level route names that cannot act as `<org>` before `/global`. */
const RESERVED_FLOW_SEGMENTS = new Set([
  "project",
  "projects",
  "search",
  "changelogs",
  "about",
  "shared",
  "flow",
  "tools",
  "fx",
  "u",
  "unsupported-country",
  "unsupported-browser",
  "unavailable",
  "age-restricted",
  "privacy",
  "credits-terms",
  "academy",
  "404",
  "login",
  "debug",
]);

/** Strips `/fx/tools/flow`, `/fx`, `/u/<digits>`, and `/<org>/global` prefixes from `pathname`. */
export function splitFlowPath(
  pathname: string = location.pathname,
): StrippedFlowPath {
  const cleanPath = (pathname || "/").split(/[?#]/)[0] || "/";
  const segs = cleanPath.split("/").filter(Boolean);
  const prefixSegs: string[] = [];
  let hasLabsFlowPrefix = false;
  let pathAuthuser: string | null = null;
  let i = 0;
  while (i < segs.length) {
    const low0 = segs[i].toLowerCase();
    const low1 = (segs[i + 1] || "").toLowerCase();
    const low2 = (segs[i + 2] || "").toLowerCase();
    if (low0 === "fx" && low1 === "tools" && low2 === "flow") {
      hasLabsFlowPrefix = true;
      prefixSegs.push(segs[i], segs[i + 1], segs[i + 2]);
      i += 3;
    } else if (low0 === "fx") {
      prefixSegs.push(segs[i]);
      i += 1;
    } else if (low0 === "u" && /^\d+$/.test(segs[i + 1] || "")) {
      pathAuthuser = segs[i + 1];
      prefixSegs.push(segs[i], segs[i + 1]);
      i += 2;
    } else if (low1 === "global" && !RESERVED_FLOW_SEGMENTS.has(low0)) {
      prefixSegs.push(segs[i], segs[i + 1]);
      i += 2;
    } else {
      break;
    }
  }
  const prefix = prefixSegs.length > 0 ? `/${prefixSegs.join("/")}` : "";
  const route =
    i >= segs.length ? "/" : `/${segs.slice(i).join("/").toLowerCase()}`;
  return { prefix, route, hasLabsFlowPrefix, pathAuthuser };
}

/** Returns `true` when a prefix-stripped lowercase `route` is a recognized Flow workspace path. */
export function isWorkspaceFlowRoute(route: string): boolean {
  if (
    route === "/" ||
    route === "/projects" ||
    route === "/search" ||
    route === "/changelogs"
  ) {
    return true;
  }
  if (!route.startsWith("/project/")) return false;
  const [projectId, ...sub] = route.slice("/project/".length).split("/");
  if (!projectId) return false;
  if (sub.length === 0) return true;
  if (sub.length === 1) {
    return ["character", "tools", "create-tool", "trash", "chat"].includes(
      sub[0],
    );
  }
  if (sub.length === 2) {
    return (
      Boolean(sub[1]) &&
      ["character", "scene", "edit", "tool", "collection", "chat"].includes(
        sub[0],
      )
    );
  }
  if (sub.length === 3) {
    return (
      (sub[0] === "collection" && Boolean(sub[1]) && sub[2] === "character") ||
      (sub[0] === "trash" && sub[1] === "collection" && Boolean(sub[2]))
    );
  }
  return false;
}

/** Returns `true` when `hostname` and `pathname` target an allowlisted Flow workspace route. */
export function isWorkspaceLocation(
  hostname: string,
  pathname: string,
): boolean {
  const host = (hostname || "").toLowerCase();
  const onLabsHost = host === "labs.google" || host.endsWith(".labs.google");
  if (host !== "flow.google.com" && !onLabsHost) {
    return false;
  }
  const stripped = splitFlowPath(pathname || "/");
  if (onLabsHost && !stripped.hasLabsFlowPrefix) {
    return false;
  }
  return isWorkspaceFlowRoute(stripped.route);
}

/** Resolves the active `authuser` value from URL query, `/u/<digits>` prefix, or `WIZ_global_data`. */
export function resolveFlowAuthuser(
  search: string = location.search,
  pathname: string = location.pathname,
): string | null {
  const fromQuery = new URLSearchParams(search).get("authuser")?.trim();
  if (fromQuery) return fromQuery;
  const { pathAuthuser } = splitFlowPath(pathname);
  if (pathAuthuser) return pathAuthuser;
  const fromWiz = window.WIZ_global_data?.QrtxK;
  return typeof fromWiz === "string" && fromWiz.trim() ? fromWiz.trim() : null;
}

/** Resolves the active `pageId` value from URL query or `WIZ_global_data.S06Grb`. */
export function resolveFlowPageId(
  search: string = location.search,
): string | null {
  const fromQuery = new URLSearchParams(search).get("pageId")?.trim();
  if (fromQuery) return fromQuery;
  const fromWiz = window.WIZ_global_data?.S06Grb;
  return typeof fromWiz === "string" && fromWiz.trim() ? fromWiz.trim() : null;
}
