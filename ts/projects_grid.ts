// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Scan Google Flow home-page project cards and sentinel pages within one deadline.

import {
  buildProjectUrl,
  readOwn,
  resolveLView,
  withMapCapture,
  type NgContextCarrier,
} from "./angular";
import { delay } from "./dom";

/** Default time limit in milliseconds for pagination and confirmation in `projectsOp`. */
const DEFAULT_PROJECTS_OP_TIMEOUT_MS = 45_000;

/** Maximum number of sentinel pages scrolled in one grid scan. */
const MAX_GRID_PAGES = 50;

/** Pattern that matches a standard UUID string. */
const UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Selector for icon, button, badge, and hidden elements excluded from card titles. */
const CARD_ICON_OR_META_SELECTOR =
  'mat-icon, [class*="mat-icon"], .google-symbols, .material-icons, [class*="material-symbols"], button, [role="button"], flow-project-owner-badge, .comment-count-badge, [aria-hidden="true"]';

/** Material icon ligature names excluded when scanning card title lines. */
const ICON_LIGATURE_RE =
  /^(?:more_vert|delete|edit|group|groups|person|people|share|lock|public|chat_bubble|add|check|close)$/i;

/** Card descriptor captured on the Flow projects grid. */
export interface ScannedProjectCard {
  /** Resolved project UUID if discovered. */
  id: string | null;
  /** Visible project card title. */
  title: string | null;
  /** Navigable project URL. */
  url: string | null;
  /** Underlying card DOM element for delete triggers. */
  _card: HTMLElement;
}

/** Shared deadline budget and network helpers for one `projectsOp` call. */
export interface ProjectsGridContext {
  /** Returns the remaining milliseconds before the deadline. */
  remainingMs: () => number;
  /** Returns true when the deadline has passed. */
  deadlineExpired: () => boolean;
  /** Waits up to `ms` without passing the deadline and returns true if time remains. */
  waitBeforeDeadline: (ms: number) => Promise<boolean>;
  /** Collects rendered project cards without scrolling sentinel pages. */
  collectRenderedCards: (
    hoverUnresolved: boolean,
  ) => Promise<ScannedProjectCard[]>;
  /** Scrolls grid sentinel pages until `stopWhen` matches, pages settle, or the deadline expires. */
  scanGridCards: (
    stopWhen?: (items: ScannedProjectCard[]) => boolean,
  ) => Promise<{ items: ScannedProjectCard[]; truncated: boolean }>;
  /** Runs `triggerFn` and waits for non-telemetry requests within `maxWaitMs` and the deadline. */
  runAndAwaitNetwork: (
    triggerFn: () => Promise<void>,
    waitStartMs?: number,
    maxWaitMs?: number,
  ) => Promise<boolean>;
}

/** Returns true when `rawUrl` points to a Google telemetry or error-logging endpoint. */
function isTelemetryUrl(rawUrl: unknown): boolean {
  const s = String(rawUrl || "");
  return (
    s.includes("play.google.com/log") ||
    s.includes("/jserror") ||
    s.includes("google-analytics")
  );
}

/** Searches `obj` recursively up to depth 4 for a project UUID field. */
function extractIdFromObject(
  obj: unknown,
  depth: number,
  seen: Set<unknown>,
): string | null {
  if (!obj || typeof obj !== "object" || depth > 4 || seen.has(obj)) {
    return null;
  }
  seen.add(obj);
  for (const k of ["projectId", "id", "uuid", "workflowId"]) {
    const val = readOwn(obj, k);
    if (typeof val === "string") {
      const hit = UUID_RE.exec(val);
      if (hit) return hit[0];
    }
  }
  if (Array.isArray(obj)) {
    for (let i = 0; i < Math.min(obj.length, 25); i++) {
      const hit = extractIdFromObject(obj[i], depth + 1, seen);
      if (hit) return hit;
    }
  } else {
    for (const k of Object.keys(obj).slice(0, 25)) {
      if (k === "parent" || k === "ownerDocument" || k === "window") continue;
      const hit = extractIdFromObject(readOwn(obj, k), depth + 1, seen);
      if (hit) return hit;
    }
  }
  return null;
}

/** Extracts text from `el` while skipping icon ligatures, buttons, and metadata badges. */
function cleanTitleElementText(el: Element | null): string | null {
  if (!el) return null;
  if (el instanceof HTMLInputElement) {
    const val = el.value.trim();
    return val.length > 0 ? val : null;
  }
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (
        parent.matches(
          'mat-icon, [class*="mat-icon"], .google-symbols, .material-icons, [class*="material-symbols"]',
        )
      ) {
        return NodeFilter.FILTER_REJECT;
      }
      const metaAncestor =
        parent !== el ? parent.closest(CARD_ICON_OR_META_SELECTOR) : null;
      if (metaAncestor && metaAncestor !== el && el.contains(metaAncestor)) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const parts: string[] = [];
  let current = walker.nextNode();
  while (current) {
    const txt = (current.nodeValue || "").replace(/\s+/g, " ").trim();
    if (txt) parts.push(txt);
    current = walker.nextNode();
  }
  const line = parts
    .join(" ")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => s.length > 0 && !ICON_LIGATURE_RE.test(s));
  return line || null;
}

/** Reads the clean project title from a `flow-project-card` element. */
export function readCardTitle(card: HTMLElement): string | null {
  const explicit = card.querySelector(".project-title-text");
  if (explicit) {
    return cleanTitleElementText(explicit);
  }
  const fallback = card.querySelector(
    '.project-title-label, [data-testid="project-title"], h2, h3, h4',
  );
  return fallback ? cleanTitleElementText(fallback) : null;
}

/** Reads the clean project title from an anchor element or its parent card. */
function readLinkTitle(link: HTMLElement): string | null {
  const parentCard = link.closest("flow-project-card");
  if (parentCard instanceof HTMLElement) {
    return readCardTitle(parentCard);
  }
  const explicit = link.querySelector(
    ".project-title-text, .project-title-label, h2, h3, h4",
  );
  return cleanTitleElementText(explicit ?? link);
}

/** Collects scrollable ancestor elements of `target` plus `document.scrollingElement`. */
function findScrollContainers(target: HTMLElement): HTMLElement[] {
  const containers: HTMLElement[] = [];
  let cur: HTMLElement | null = target.parentElement;
  while (cur) {
    const style = window.getComputedStyle(cur);
    if (
      cur.scrollHeight > cur.clientHeight ||
      /^(?:auto|scroll|overlay)$/i.test(style.overflowY)
    ) {
      containers.push(cur);
    }
    cur = cur.parentElement;
  }
  if (
    document.scrollingElement instanceof HTMLElement &&
    !containers.includes(document.scrollingElement)
  ) {
    containers.push(document.scrollingElement);
  }
  return containers;
}

/** Inspects the Angular infinite-query state on `grid` and optionally triggers `fetchNextPage`. */
function probeInfiniteGridQuery(
  grid: Element | null,
  shouldNudge: boolean,
): { hasNext: boolean | null; fetching: boolean } {
  if (!grid) return { hasNext: null, fetching: false };
  const lv = resolveLView(grid);
  if (!Array.isArray(lv)) return { hasNext: null, fetching: false };
  const seen = new Set<unknown>();
  const inspect = (
    cand: unknown,
    depth: number,
  ): { hasNext: boolean | null; fetching: boolean } | null => {
    if (!cand || typeof cand !== "object" || depth > 2 || seen.has(cand)) {
      return null;
    }
    seen.add(cand);
    const hasNext = readOwn(cand, "hasNextPage");
    const fetchNext = readOwn(cand, "fetchNextPage");
    if (typeof hasNext === "function" && typeof fetchNext === "function") {
      if (!hasNext.call(cand)) {
        return { hasNext: false, fetching: false };
      }
      const isFetchingNext = readOwn(cand, "isFetchingNextPage");
      const isFetchingAny = readOwn(cand, "isFetching");
      const fetching =
        (typeof isFetchingNext === "function" &&
          Boolean(isFetchingNext.call(cand))) ||
        (typeof isFetchingAny === "function" &&
          Boolean(isFetchingAny.call(cand)));
      if (shouldNudge && !fetching) {
        void Promise.resolve(fetchNext.call(cand)).catch(() => null);
        return { hasNext: true, fetching: true };
      }
      return { hasNext: true, fetching };
    }
    if (!Array.isArray(cand) && !(cand instanceof Node)) {
      for (const k of Object.keys(cand).slice(0, 20)) {
        const res = inspect(readOwn(cand, k), depth + 1);
        if (res !== null) return res;
      }
    }
    return null;
  };
  for (const slot of lv) {
    const res = inspect(slot, 0);
    if (res !== null) return res;
  }
  return { hasNext: null, fetching: false };
}

/** Observes non-telemetry `fetch` and `XMLHttpRequest` promises while `fn` runs. */
async function withNetworkObserver<T>(
  onRequest: (done: Promise<void>) => void,
  fn: () => Promise<T>,
): Promise<T> {
  const origFetch = window.fetch;
  const origXhrOpen = XMLHttpRequest.prototype.open;
  const origXhrSend = XMLHttpRequest.prototype.send;
  const xhrUrls = new WeakMap<XMLHttpRequest, string>();

  try {
    window.fetch = function (
      this: Window,
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url || "";
      const p = origFetch.call(this, input, init);
      if (!isTelemetryUrl(url)) {
        onRequest(p.then(() => undefined, () => undefined));
      }
      return p;
    };
    XMLHttpRequest.prototype.open = function (
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      asyncFlag = true,
      username?: string | null,
      password?: string | null,
    ): void {
      xhrUrls.set(this, String(url || ""));
      if (arguments.length <= 2) {
        origXhrOpen.call(this, method, url, true);
      } else {
        origXhrOpen.call(
          this,
          method,
          url,
          Boolean(asyncFlag),
          username ?? null,
          password ?? null,
        );
      }
    };
    XMLHttpRequest.prototype.send = function (
      this: XMLHttpRequest,
      body?: Document | XMLHttpRequestBodyInit | null,
    ): void {
      if (!isTelemetryUrl(xhrUrls.get(this))) {
        onRequest(
          new Promise<void>((res) => {
            this.addEventListener("loadend", () => res(), { once: true });
          }),
        );
      }
      origXhrSend.call(this, body);
    };
    return await fn();
  } finally {
    window.fetch = origFetch;
    XMLHttpRequest.prototype.open = origXhrOpen;
    XMLHttpRequest.prototype.send = origXhrSend;
  }
}

/** Creates deadline-bounded grid scanning and network helpers for one `projectsOp` call. */
export function createProjectsGridContext(
  rawTimeoutMs?: number,
): ProjectsGridContext {
  const timeoutMs =
    typeof rawTimeoutMs === "number" && Number.isFinite(rawTimeoutMs)
      ? Math.max(0, rawTimeoutMs)
      : DEFAULT_PROJECTS_OP_TIMEOUT_MS;
  const deadline = globalThis.performance.now() + timeoutMs;
  const remainingMs = (): number => deadline - globalThis.performance.now();
  const deadlineExpired = (): boolean => remainingMs() <= 0;
  const waitBeforeDeadline = async (ms: number): Promise<boolean> => {
    const rem = remainingMs();
    if (rem <= 0) return false;
    await delay(Math.min(ms, rem));
    return !deadlineExpired();
  };

  const seenMaps = new Set<Map<unknown, unknown>>();
  const hoveredCards = new WeakSet<HTMLElement>();

  const extractCardId = (card: HTMLElement): string | null => {
    const link = card.querySelector('a[href*="/project/"]');
    const href = link?.getAttribute("href") || "";
    const m = /\/project\/([^/?#]+)/.exec(href);
    if (m) return m[1];
    for (const attr of card.getAttributeNames()) {
      const val = card.getAttribute(attr) || "";
      const um = UUID_RE.exec(val);
      if (um) return um[0];
    }
    const ng = (card as NgContextCarrier).__ngContext__;
    if (Array.isArray(ng)) {
      return extractIdFromObject(ng, 0, new Set());
    }
    if (typeof ng === "number") {
      for (const sm of seenMaps) {
        try {
          const lv = sm.get(ng);
          if (Array.isArray(lv)) {
            const pid = extractIdFromObject(lv, 0, new Set());
            if (pid) return pid;
          }
        } catch {
          // Ignore map read error.
        }
      }
    }
    return null;
  };

  const collectRenderedCards = async (
    hoverUnresolved: boolean,
  ): Promise<ScannedProjectCard[]> => {
    const cards = Array.from(document.querySelectorAll("flow-project-card"));
    if (hoverUnresolved && !deadlineExpired()) {
      const unresolved = cards.filter(
        (card): card is HTMLElement =>
          card instanceof HTMLElement &&
          !hoveredCards.has(card) &&
          !extractCardId(card) &&
          typeof (card as NgContextCarrier).__ngContext__ === "number",
      );
      if (unresolved.length > 0) {
        await withMapCapture(
          (map, _key, _value, write) => {
            if (!write) seenMaps.add(map);
          },
          async () => {
            for (const card of unresolved) {
              hoveredCards.add(card);
              const r = card.getBoundingClientRect();
              card.dispatchEvent(
                new PointerEvent("pointerenter", {
                  bubbles: false,
                  clientX: r.left + 12,
                  clientY: r.top + 12,
                }),
              );
              card.dispatchEvent(
                new MouseEvent("mouseenter", {
                  bubbles: false,
                  clientX: r.left + 12,
                  clientY: r.top + 12,
                }),
              );
            }
            await waitBeforeDeadline(80);
          },
        );
      }
    }

    const byId = new Map<string, ScannedProjectCard>();
    for (let idx = 0; idx < cards.length; idx++) {
      const card = cards[idx];
      if (!(card instanceof HTMLElement)) continue;
      const pid = extractCardId(card);
      const title = readCardTitle(card);
      const key = pid || `card:${idx}`;
      if (!byId.has(key)) {
        byId.set(key, {
          id: pid,
          title,
          url: pid ? buildProjectUrl(pid) : null,
          _card: card,
        });
      }
    }

    for (const a of document.querySelectorAll('a[href*="/project/"]')) {
      if (!(a instanceof HTMLElement)) continue;
      const href = a.getAttribute("href") || "";
      const m = /\/project\/([^/?#]+)/.exec(href);
      if (!m) continue;
      const pid = m[1];
      if (!byId.has(pid)) {
        const cardParent = a.closest("flow-project-card");
        byId.set(pid, {
          id: pid,
          title: readLinkTitle(a),
          url: new URL(href, location.origin).href,
          _card: cardParent instanceof HTMLElement ? cardParent : a,
        });
      }
    }
    return Array.from(byId.values());
  };

  const scanGridCards = async (
    stopWhen?: (items: ScannedProjectCard[]) => boolean,
  ): Promise<{ items: ScannedProjectCard[]; truncated: boolean }> => {
    let activeRequests = 0;
    return await withNetworkObserver(
      (done) => {
        activeRequests++;
        void done.finally(() => {
          activeRequests = Math.max(0, activeRequests - 1);
        });
      },
      async () => {
        let lastCount = -1;
        let stableTicks = 0;
        for (let i = 0; i < 60 && !deadlineExpired(); i++) {
          const loading = Boolean(
            document.querySelector(
              "flow-loading-page, .projects-loading-container",
            ),
          );
          const hasCreateBtn = Boolean(
            document.querySelector(
              "button.projects-grid-new-project-button, button.new-project-button",
            ),
          );
          const cnt = document.querySelectorAll(
            'flow-project-card, a[href*="/project/"]',
          ).length;
          if (cnt > 0 && cnt === lastCount) {
            stableTicks++;
            if (stableTicks >= 3) break;
          } else if (!loading && hasCreateBtn && cnt === 0) {
            stableTicks++;
            if (stableTicks >= 3) break;
          } else {
            lastCount = cnt;
            stableTicks = 0;
          }
          if (!(await waitBeforeDeadline(150))) break;
        }

        let items = await collectRenderedCards(true);
        if (stopWhen?.(items)) {
          return { items, truncated: false };
        }
        if (deadlineExpired()) {
          const hasSentinel = Boolean(
            document.querySelector("flow-projects-grid .load-more-sentinel"),
          );
          const loading = Boolean(
            document.querySelector(
              "flow-loading-page, .projects-loading-container",
            ),
          );
          return {
            items,
            truncated: hasSentinel || loading || activeRequests > 0,
          };
        }

        const countEntries = (): number =>
          document.querySelectorAll('flow-project-card, a[href*="/project/"]')
            .length;
        let settledAttempts = 0;
        let truncated = false;

        for (let page = 0; page < MAX_GRID_PAGES; page++) {
          const grid = document.querySelector("flow-projects-grid");
          const sentinel =
            grid?.querySelector(".load-more-sentinel") ??
            document.querySelector("flow-projects-grid .load-more-sentinel");
          if (!(sentinel instanceof HTMLElement)) {
            truncated = false;
            break;
          }
          if (deadlineExpired()) {
            truncated = true;
            break;
          }

          const beforeCount = countEntries();
          const scrollers = findScrollContainers(sentinel);
          if (settledAttempts > 0) {
            for (const scroller of scrollers) {
              scroller.scrollTop = Math.max(
                0,
                scroller.scrollTop - Math.max(240, window.innerHeight),
              );
              scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
            }
            if (!(await waitBeforeDeadline(40))) {
              truncated = true;
              break;
            }
          }
          sentinel.scrollIntoView({ block: "end", inline: "nearest" });
          for (const scroller of scrollers) {
            scroller.scrollTop = scroller.scrollHeight;
            scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
          }
          window.dispatchEvent(new Event("scroll"));

          let advanced = false;
          let nudgedQuery = false;
          let reachedEnd = false;
          const idleTickLimit = settledAttempts === 0 ? 15 : 25;
          for (let tick = 0; tick < 80; tick++) {
            if (!(await waitBeforeDeadline(100))) {
              truncated = true;
              break;
            }
            if (countEntries() > beforeCount) {
              advanced = true;
              break;
            }
            const liveSentinel =
              grid?.querySelector(".load-more-sentinel") ??
              document.querySelector("flow-projects-grid .load-more-sentinel");
            if (!liveSentinel) {
              reachedEnd = true;
              break;
            }
            const shouldNudge = !nudgedQuery && tick >= 3;
            if (shouldNudge) nudgedQuery = true;
            const queryState = probeInfiniteGridQuery(grid, shouldNudge);
            if (queryState.hasNext === false) {
              reachedEnd = true;
              break;
            }
            const spinnerBusy = Boolean(
              liveSentinel.querySelector('mat-spinner, [role="progressbar"]') ??
                grid?.querySelector('mat-spinner, [role="progressbar"]'),
            );
            const busy =
              spinnerBusy || queryState.fetching || activeRequests > 0;
            if (!busy && tick >= idleTickLimit) {
              break;
            }
          }

          if (advanced) {
            await waitBeforeDeadline(60);
          }
          items = await collectRenderedCards(true);
          if (stopWhen?.(items)) {
            return { items, truncated: false };
          }
          if (truncated || deadlineExpired()) {
            truncated = true;
            break;
          }
          if (reachedEnd) {
            truncated = false;
            break;
          }
          if (advanced && countEntries() > beforeCount) {
            settledAttempts = 0;
            if (page + 1 === MAX_GRID_PAGES) {
              const stillHasSentinel = Boolean(
                document.querySelector(
                  "flow-projects-grid .load-more-sentinel",
                ),
              );
              if (
                stillHasSentinel &&
                probeInfiniteGridQuery(grid, false).hasNext !== false
              ) {
                truncated = true;
              }
            }
          } else {
            settledAttempts++;
            if (settledAttempts >= 2) break;
          }
        }

        return { items, truncated };
      },
    );
  };

  const runAndAwaitNetwork = async (
    triggerFn: () => Promise<void>,
    waitStartMs = 350,
    maxWaitMs = 8000,
  ): Promise<boolean> => {
    const inFlight: Array<Promise<void>> = [];
    return await withNetworkObserver(
      (done) => {
        inFlight.push(done);
      },
      async () => {
        await triggerFn();
        await waitBeforeDeadline(waitStartMs);
        if (inFlight.length === 0) {
          return true;
        }
        const limitMs = Math.min(maxWaitMs, Math.max(0, remainingMs()));
        if (limitMs <= 0) {
          return false;
        }
        return await Promise.race([
          Promise.allSettled(inFlight).then(() => true),
          delay(limitMs).then(() => false),
        ]);
      },
    );
  };

  return {
    remainingMs,
    deadlineExpired,
    waitBeforeDeadline,
    collectRenderedCards,
    scanGridCards,
    runAndAwaitNetwork,
  };
}
