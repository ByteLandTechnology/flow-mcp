// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// List, rename, and delete Google Flow projects from the Flow UI.

import {
  buildProjectUrl,
  readOwn,
  resolveLView,
  withMapCapture,
  type NgContextCarrier,
} from "./angular";
import { delay, elText, setNativeValue } from "./dom";
import { projectTitleFormat } from "./frontend_builds";
import type { ProjectsOpRequest } from "./types";

/** Internal card descriptor captured on the Flow projects grid. */
interface ScannedProjectCard {
  /** Resolved project UUID if discovered. */
  id: string | null;
  /** Visible project card title. */
  title: string | null;
  /** Navigable project URL. */
  url: string | null;
  /** Underlying card DOM element for delete triggers. */
  _card: HTMLElement;
}

/** Lists, renames, or deletes Google Flow projects on home or workspace pages. */
export async function projectsOp(req: ProjectsOpRequest): Promise<unknown> {
  const UUID_RE =
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

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

  const MAX_GRID_PAGES = 50;
  const CARD_ICON_OR_META_SELECTOR =
    'mat-icon, [class*="mat-icon"], .google-symbols, .material-icons, [class*="material-symbols"], button, [role="button"], flow-project-owner-badge, .comment-count-badge, [aria-hidden="true"]';
  const ICON_LIGATURE_RE =
    /^(?:more_vert|delete|edit|group|groups|person|people|share|lock|public|chat_bubble|add|check|close)$/i;

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

  function readCardTitle(card: HTMLElement): string | null {
    const explicit = card.querySelector(".project-title-text");
    if (explicit) {
      return cleanTitleElementText(explicit);
    }
    const fallback = card.querySelector(
      '.project-title-label, [data-testid="project-title"], h2, h3, h4',
    );
    return fallback ? cleanTitleElementText(fallback) : null;
  }

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

  function nudgeInfiniteGridQuery(grid: Element | null): boolean | null {
    if (!grid) return null;
    const lv = resolveLView(grid);
    if (!Array.isArray(lv)) return null;
    const seen = new Set<unknown>();
    const inspect = (cand: unknown, depth: number): boolean | null => {
      if (!cand || typeof cand !== "object" || depth > 2 || seen.has(cand)) {
        return null;
      }
      seen.add(cand);
      const hasNext = readOwn(cand, "hasNextPage");
      const fetchNext = readOwn(cand, "fetchNextPage");
      if (typeof hasNext === "function" && typeof fetchNext === "function") {
        if (!hasNext.call(cand)) return false;
        const isFetching = readOwn(cand, "isFetchingNextPage");
        if (typeof isFetching !== "function" || !isFetching.call(cand)) {
          void Promise.resolve(fetchNext.call(cand)).catch(() => null);
        }
        return true;
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
    return null;
  }

  async function scrollGridSentinelPages(): Promise<void> {
    const countEntries = (): number =>
      document.querySelectorAll('flow-project-card, a[href*="/project/"]')
        .length;
    let settledAttempts = 0;
    for (let page = 0; page < MAX_GRID_PAGES; page++) {
      const grid = document.querySelector("flow-projects-grid");
      const sentinel =
        grid?.querySelector(".load-more-sentinel") ??
        document.querySelector("flow-projects-grid .load-more-sentinel");
      if (!(sentinel instanceof HTMLElement)) break;

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
        await delay(40);
      }
      sentinel.scrollIntoView({ block: "end", inline: "nearest" });
      for (const scroller of scrollers) {
        scroller.scrollTop = scroller.scrollHeight;
        scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
      }
      window.dispatchEvent(new Event("scroll"));

      let advanced = false;
      let nudgedQuery = false;
      for (let tick = 0; tick < 30; tick++) {
        await delay(100);
        if (countEntries() > beforeCount) {
          advanced = true;
          break;
        }
        const liveSentinel =
          grid?.querySelector(".load-more-sentinel") ??
          document.querySelector("flow-projects-grid .load-more-sentinel");
        if (!liveSentinel) {
          advanced = true;
          break;
        }
        const busy = Boolean(
          liveSentinel.querySelector('mat-spinner, [role="progressbar"]'),
        );
        if (!busy && tick === 3 && !nudgedQuery) {
          nudgedQuery = true;
          if (nudgeInfiniteGridQuery(grid) === false) {
            return;
          }
        }
        if (!busy && tick >= 8) {
          break;
        }
      }
      if (advanced && countEntries() > beforeCount) {
        settledAttempts = 0;
        await delay(60);
      } else {
        settledAttempts++;
        if (settledAttempts >= 2) break;
      }
    }
  }

  async function scanCards(): Promise<ScannedProjectCard[]> {
    let lastCount = -1;
    let stableTicks = 0;
    for (let i = 0; i < 60; i++) {
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
      await delay(150);
    }

    await scrollGridSentinelPages();

    const seenMaps = new Set<Map<unknown, unknown>>();
    await withMapCapture((map, _key, _value, write) => {
      if (!write) seenMaps.add(map);
    }, async () => {
      const cards = Array.from(document.querySelectorAll("flow-project-card"));
      for (const card of cards) {
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
      await delay(80);
    });

    const byId = new Map<string, ScannedProjectCard>();
    const cards = Array.from(document.querySelectorAll("flow-project-card"));
    for (let idx = 0; idx < cards.length; idx++) {
      const card = cards[idx];
      if (!(card instanceof HTMLElement)) continue;
      const link = card.querySelector('a[href*="/project/"]');
      const href = link?.getAttribute("href") || "";
      let pid: string | null = null;
      const m = /\/project\/([^/?#]+)/.exec(href);
      if (m) pid = m[1];
      if (!pid) {
        for (const attr of card.getAttributeNames()) {
          const val = card.getAttribute(attr) || "";
          const um = UUID_RE.exec(val);
          if (um) {
            pid = um[0];
            break;
          }
        }
      }
      if (!pid) {
        const ng = (card as NgContextCarrier).__ngContext__;
        if (Array.isArray(ng)) {
          pid = extractIdFromObject(ng, 0, new Set());
        } else if (typeof ng === "number") {
          for (const sm of seenMaps) {
            try {
              const lv = sm.get(ng);
              if (Array.isArray(lv)) {
                pid = extractIdFromObject(lv, 0, new Set());
                if (pid) break;
              }
            } catch {
              // Ignore map read error.
            }
          }
        }
      }
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
  }

  async function runAndAwaitNetwork(
    triggerFn: () => Promise<void>,
    waitStartMs = 350,
    maxWaitMs = 8000,
  ): Promise<void> {
    const origFetch = window.fetch;
    const origXhrOpen = XMLHttpRequest.prototype.open;
    const origXhrSend = XMLHttpRequest.prototype.send;
    const xhrUrls = new WeakMap<XMLHttpRequest, string>();
    const inFlight: Array<Promise<unknown>> = [];
    const isTelemetry = (rawUrl: unknown): boolean => {
      const s = String(rawUrl || "");
      return (
        s.includes("play.google.com/log") ||
        s.includes("/jserror") ||
        s.includes("google-analytics")
      );
    };

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
        if (!isTelemetry(url)) {
          inFlight.push(p.catch(() => null));
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
        if (!isTelemetry(xhrUrls.get(this))) {
          inFlight.push(
            new Promise<void>((res) => {
              this.addEventListener("loadend", () => res(), { once: true });
            }),
          );
        }
        origXhrSend.call(this, body);
      };

      await triggerFn();
      await delay(waitStartMs);
      if (inFlight.length > 0) {
        await Promise.race([Promise.allSettled(inFlight), delay(maxWaitMs)]);
      }
    } finally {
      window.fetch = origFetch;
      XMLHttpRequest.prototype.open = origXhrOpen;
      XMLHttpRequest.prototype.send = origXhrSend;
    }
  }

  const action = String(req?.action || "list").toLowerCase();

  if (action === "list") {
    const items = await scanCards();
    return {
      ok: true,
      projects: items.map(({ id, title, url }) => ({ id, title, url })),
    };
  }

  if (action === "set_title") {
    const desired = String(req?.title || "").trim();
    if (!desired) return { ok: false, error: "empty_title" };
    const isSubroutePath = (): boolean =>
      /\/project\/[^/?#]+\/[^/?#]+/.test(location.pathname || "");
    const isProjectRootPath = (): boolean =>
      /\/project\/[^/?#]+\/?$/.test(location.pathname || "");
    if (isSubroutePath()) {
      return { ok: false, error: "project_subroute_active" };
    }
    if (!isProjectRootPath()) {
      return { ok: false, error: "not_in_project_root" };
    }
    const headerHostSelector =
      "flow-project-page flow-tile-view-header flow-navigation-header flow-editable-text";
    const headerInputSelector = `${headerHostSelector} input.editable-text-input, ${headerHostSelector} input[aria-label="Editable text"], ${headerHostSelector} input`;
    let input: HTMLInputElement | null = null;
    for (let i = 0; i < 40; i++) {
      if (isSubroutePath()) {
        return { ok: false, error: "project_subroute_active" };
      }
      if (!isProjectRootPath()) {
        return { ok: false, error: "not_in_project_root" };
      }
      const candidates = Array.from(
        document.querySelectorAll(headerInputSelector),
      );
      const found = candidates.find(
        (cand): cand is HTMLInputElement =>
          cand instanceof HTMLInputElement &&
          !cand.closest(
            "flow-project-sidenav-container, mat-sidenav, aside",
          ) &&
          cand.getClientRects().length > 0,
      );
      if (found) {
        input = found;
        break;
      }
      await delay(100);
    }
    if (!input) return { ok: false, error: "project_title_input_not_found" };
    const titleInput = input;
    const host = titleInput.closest(headerHostSelector);
    if (!host) return { ok: false, error: "project_title_input_not_found" };
    if ((titleInput.value || "").trim() === desired) {
      return { ok: true, title: desired };
    }
    let abortedOnRoute = false;
    await runAndAwaitNetwork(
      async () => {
        if (isSubroutePath() || !isProjectRootPath()) {
          abortedOnRoute = true;
          return;
        }
        titleInput.focus();
        titleInput.dispatchEvent(new FocusEvent("focus", { bubbles: false }));
        await delay(50);
        setNativeValue(titleInput, desired);
        await delay(50);
        const doneBtn = host.querySelector('button[aria-label="Done"]');
        if (doneBtn instanceof HTMLElement) {
          doneBtn.click();
        } else {
          titleInput.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "Enter",
              code: "Enter",
              keyCode: 13,
              which: 13,
              bubbles: true,
              cancelable: true,
            }),
          );
        }
        await delay(60);
        if (
          host.querySelector(".editable-text-container.editing") ||
          (titleInput.value || "").trim() !== desired
        ) {
          try {
            const lv = resolveLView(host);
            if (Array.isArray(lv)) {
              const titleFormat = projectTitleFormat();
              for (const slot of lv) {
                const emitter = readOwn(slot, titleFormat.saveEmitter) as
                  | { emit?: (v: string) => void }
                  | undefined;
                const state = readOwn(slot, titleFormat.stateSignal) as
                  | { set?: (v: unknown) => void }
                  | undefined;
                if (
                  typeof emitter?.emit === "function" &&
                  typeof state?.set === "function"
                ) {
                  emitter.emit(desired);
                  state.set({ state: "viewing" });
                  break;
                }
              }
            }
          } catch {
            // Fall through to polling check.
          }
        }
      },
      400,
      6000,
    );
    if (abortedOnRoute || isSubroutePath()) {
      return { ok: false, error: "project_subroute_active" };
    }
    if (!isProjectRootPath()) {
      return { ok: false, error: "not_in_project_root" };
    }
    const isSettledTitle = (): boolean =>
      !host.querySelector(".editable-text-container.editing") &&
      (titleInput.value || "").trim() === desired;
    await delay(300);
    for (let i = 0; i < 30; i++) {
      if (isSettledTitle()) {
        await delay(200);
        if (isSettledTitle()) {
          return { ok: true, confirmed: true, title: desired };
        }
      }
      await delay(150);
    }
    return { ok: false, error: "project_title_not_confirmed" };
  }

  if (action === "delete") {
    const targetId = req?.project_id ? String(req.project_id).trim() : "";
    const targetTitle = req?.title ? String(req.title).trim() : "";
    const matchesTarget = (p: ScannedProjectCard): boolean => {
      if (targetId && p.id === targetId) return true;
      if (
        targetTitle &&
        p.title &&
        p.title.toLowerCase() === targetTitle.toLowerCase()
      ) {
        return true;
      }
      return false;
    };
    const items = await scanCards();
    const hit = items.find(matchesTarget);
    if (!hit || !hit._card) {
      return { ok: false, error: "project_card_not_found" };
    }
    const beforeMatches = items.filter(matchesTarget).length;
    const deletedId = hit.id;
    const card = hit._card;
    card.scrollIntoView({ block: "center" });
    await delay(100);
    const r = card.getBoundingClientRect();
    card.dispatchEvent(
      new PointerEvent("pointerenter", {
        bubbles: false,
        clientX: r.left + r.width / 2,
        clientY: r.top + r.height / 2,
      }),
    );
    card.dispatchEvent(
      new MouseEvent("mouseenter", {
        bubbles: false,
        clientX: r.left + r.width / 2,
        clientY: r.top + r.height / 2,
      }),
    );
    await delay(150);

    let delBtn = card.querySelector('button[aria-label="Delete project"]');
    if (!delBtn) {
      const moreBtn = card.querySelector(
        'button[aria-label*="More" i], button[aria-haspopup="menu"]',
      );
      if (moreBtn instanceof HTMLElement) {
        moreBtn.click();
        await delay(200);
        delBtn =
          document.querySelector(
            'button[aria-label="Delete project"], [role="menuitem"][aria-label*="Delete" i]',
          ) ||
          Array.from(
            document.querySelectorAll('button, [role="menuitem"]'),
          ).find((el) => /\bdelete project\b/i.test(elText(el))) ||
          null;
      }
    }
    if (!(delBtn instanceof HTMLElement)) {
      return { ok: false, error: "delete_project_button_not_found" };
    }
    delBtn.click();

    let confirmBtn: HTMLElement | null = null;
    for (let i = 0; i < 25; i++) {
      await delay(100);
      const dialogs = Array.from(
        document.querySelectorAll(
          '[role="dialog"], .mat-mdc-dialog-container, .cdk-overlay-pane',
        ),
      );
      for (const dlg of dialogs) {
        if (!/delete this project/i.test(dlg.textContent || "")) continue;
        const foundBtn = Array.from(dlg.querySelectorAll("button")).find((b) =>
          /\bdelete project\b/i.test(
            elText(b) || (b.getAttribute("aria-label") || "").trim(),
          ),
        );
        if (foundBtn instanceof HTMLElement) {
          confirmBtn = foundBtn;
          break;
        }
      }
      if (confirmBtn) break;
    }
    if (!confirmBtn) {
      return { ok: false, error: "delete_confirm_button_not_found" };
    }
    const finalConfirm = confirmBtn;
    await runAndAwaitNetwork(
      async () => {
        finalConfirm.click();
      },
      350,
      8000,
    );

    for (let i = 0; i < 60; i++) {
      if (!document.body.contains(card)) break;
      await delay(100);
    }
    const entryRemoved = (entries: ScannedProjectCard[]): boolean =>
      deletedId
        ? !entries.some((p) => p.id === deletedId)
        : entries.filter(matchesTarget).length < beforeMatches;
    await delay(300);
    for (let i = 0; i < 20; i++) {
      if (entryRemoved(await scanCards())) {
        await delay(250);
        if (entryRemoved(await scanCards())) {
          return {
            ok: true,
            confirmed: true,
            deleted_id: hit.id,
            deleted_title: hit.title,
          };
        }
      }
      await delay(250);
    }
    return { ok: false, error: "delete_card_still_present" };
  }

  return { ok: false, error: `unknown_project_action:${action}` };
}
