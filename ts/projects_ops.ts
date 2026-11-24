// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// List, rename, and delete Google Flow projects from the Flow UI.

import { readOwn, resolveLView, type NgContextCarrier } from "./angular";
import { delay, elText, setNativeValue } from "./dom";
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

    const seenMaps = new Set<Map<unknown, unknown>>();
    const origGet = Map.prototype.get;
    try {
      Map.prototype.get = function (
        this: Map<unknown, unknown>,
        k: unknown,
      ): unknown {
        seenMaps.add(this);
        return origGet.call(this, k);
      };
      const cards = Array.from(document.querySelectorAll("flow-project-card"));
      for (const card of cards.slice(0, 50)) {
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
    } finally {
      Map.prototype.get = origGet;
    }

    const byId = new Map<string, ScannedProjectCard>();
    const cards = Array.from(document.querySelectorAll("flow-project-card"));
    for (const card of cards) {
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
      const titleNode =
        card.querySelector(
          'input[aria-label="Editable text"], [class*="title"], h2, h3, h4',
        ) || card;
      const rawText = (
        (titleNode instanceof HTMLInputElement ? titleNode.value : "") ||
        elText(titleNode) ||
        ""
      )
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find((s) => s.length > 0 && !/^(?:more_vert|delete)$/i.test(s));
      const key = pid || `card:${rawText || byId.size}`;
      const projBase = location.pathname.includes("/fx/tools/flow")
        ? "/fx/tools/flow/project"
        : "/project";
      if (!byId.has(key)) {
        byId.set(key, {
          id: pid,
          title: rawText || null,
          url: pid ? `${location.origin}${projBase}/${pid}?hl=en` : null,
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
        const title = elText(a)
          .split(/\r?\n/)
          .map((s) => s.trim())
          .find(Boolean);
        const cardParent = a.closest("flow-project-card");
        byId.set(pid, {
          id: pid,
          title: title || null,
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
    let input: HTMLInputElement | null = null;
    for (let i = 0; i < 40; i++) {
      const cand = document.querySelector(
        'flow-editable-text input.editable-text-input, input[aria-label="Editable text"], .editable-text-input',
      );
      if (cand instanceof HTMLInputElement && cand.getClientRects().length > 0) {
        input = cand;
        break;
      }
      await delay(100);
    }
    if (!input) return { ok: false, error: "project_title_input_not_found" };
    const titleInput = input;
    const host = titleInput.closest("flow-editable-text");
    if ((titleInput.value || "").trim() === desired) {
      return { ok: true, title: desired };
    }
    await runAndAwaitNetwork(
      async () => {
        titleInput.focus();
        titleInput.dispatchEvent(new FocusEvent("focus", { bubbles: false }));
        await delay(50);
        setNativeValue(titleInput, desired);
        await delay(50);
        const doneBtn = (host || document).querySelector(
          'button[aria-label="Done"]',
        );
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
          host &&
          (host.querySelector(".editable-text-container.editing") ||
            (titleInput.value || "").trim() !== desired)
        ) {
          try {
            const lv = resolveLView(host);
            if (Array.isArray(lv)) {
              for (const slot of lv) {
                const hsa = readOwn(slot, "HSa") as { emit?: (v: string) => void } | undefined;
                const tJa = readOwn(slot, "tJa") as { emit?: (v: string) => void } | undefined;
                const emitter =
                  typeof hsa?.emit === "function"
                    ? hsa
                    : typeof tJa?.emit === "function"
                      ? tJa
                      : undefined;
                const state = readOwn(slot, "state") as { set?: (v: unknown) => void } | undefined;
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
    for (let i = 0; i < 15; i++) {
      if ((titleInput.value || "").trim() === desired) break;
      await delay(100);
    }
    return { ok: true, title: (titleInput.value || desired).trim() };
  }

  if (action === "delete") {
    const targetId = req?.project_id ? String(req.project_id).trim() : "";
    const targetTitle = req?.title ? String(req.title).trim() : "";
    const items = await scanCards();
    const hit = items.find((p) => {
      if (targetId && p.id === targetId) return true;
      if (
        targetTitle &&
        p.title &&
        p.title.toLowerCase() === targetTitle.toLowerCase()
      ) {
        return true;
      }
      return false;
    });
    if (!hit || !hit._card) {
      return { ok: false, error: "project_card_not_found" };
    }
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
    if (document.body.contains(card)) {
      return { ok: false, error: "delete_card_still_present" };
    }
    await delay(300);
    return { ok: true, deleted_id: hit.id, deleted_title: hit.title };
  }

  return { ok: false, error: `unknown_project_action:${action}` };
}
