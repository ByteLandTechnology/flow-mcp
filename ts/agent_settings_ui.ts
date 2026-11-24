// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Read and update Flow Agent confirmation policy, media defaults, and memory cards via panel UI.

import { clickButtonByRegex, delay, dismissOverlay, elText, isVisibleEnabled, setNativeValue } from "./dom";
import type {
  AgentSettingsPatch,
  ConfirmPolicy,
  GenerationDefaultsPatch,
  MemoryCardFields,
  MemoryPatch,
} from "./agent_settings_protocol";

/** Normalized media defaults section read from the Agent settings UI. */
interface UiMediaDefaults {
  /** Selected model identifier or null if unset. */
  model: string | null;
  /** Selected aspect ratio label. */
  aspect_ratio: string;
  /** Selected output count per generation. */
  output_count: number;
  /** Available model choices exposed in the control. */
  available_models: Array<{ id: string; name: string; aspect_ratios: string[] }>;
}

/** Normalized memory card read from the Agent settings UI. */
type UiMemoryCard = MemoryCardFields & { id: string };

/** True while a UI settings update is running so `agentBusy` reports busy status. */
export let uiSettingsWritePending = false;

/** Finds the workspace Agent panel root element. */
export function findAgentPanelRoot(): HTMLElement | null {
  const candidates = document.querySelectorAll<HTMLElement>(
    "flow-agent-panel, .agent-panel-wrapper, [data-agent-panel], aside.agent-panel",
  );
  for (const el of candidates) {
    if (el.getClientRects().length > 0) return el;
  }
  const promptBox = document.querySelector<HTMLElement>("flow-creative-agent-prompt-box");
  if (promptBox && promptBox.getClientRects().length > 0) {
    return promptBox.closest<HTMLElement>("aside, section, .agent-panel-wrapper") ?? promptBox.parentElement;
  }
  return null;
}

/** Opens the workspace Agent side panel if it is currently collapsed. */
export async function ensureAgentPanelOpen(): Promise<HTMLElement | null> {
  const existing = findAgentPanelRoot();
  if (existing) return existing;
  const toggles = Array.from(
    document.querySelectorAll<HTMLElement>(
      'flow-agent-mode-toggle-chip button, button[aria-label*="Agent" i], button[aria-label*="Creative agent" i], [data-action="toggle-agent"], button',
    ),
  ).filter((el) => {
    if (!isVisibleEnabled(el)) return false;
    const label = `${el.getAttribute("aria-label") || ""} ${elText(el)}`.trim();
    return /^(?:agent|open agent|show agent|creative agent|flow agent)$/i.test(label);
  });
  if (toggles[0]) {
    toggles[0].click();
    for (let i = 0; i < 30; i++) {
      await delay(100);
      const opened = findAgentPanelRoot();
      if (opened) return opened;
    }
  }
  return findAgentPanelRoot();
}

/** Finds the rendered Agent settings container if open. */
function findSettingsContainer(): HTMLElement | null {
  const selectors = [
    "flow-agent-settings",
    "[data-agent-settings]",
    ".agent-settings-panel",
    '[role="dialog"][aria-label*="Agent" i]',
    '[role="dialog"][aria-label*="settings" i]',
  ];
  for (const sel of selectors) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el && el.getClientRects().length > 0) return el;
  }
  return null;
}

/** Opens the Agent settings view from the Agent panel header and returns its root container. */
async function openSettingsView(panel: HTMLElement): Promise<{ root: HTMLElement; openedNow: boolean } | null> {
  const already = findSettingsContainer();
  if (already) return { root: already, openedNow: false };

  const btn = Array.from(
    panel.querySelectorAll<HTMLElement>('button, [role="button"]'),
  ).find((el) => {
    if (!isVisibleEnabled(el)) return false;
    const label = `${el.getAttribute("aria-label") || ""} ${el.getAttribute("title") || ""} ${elText(el)}`.trim();
    return /\b(?:agent settings|project settings|settings|preferences|tune)\b/i.test(label);
  });
  if (!btn) return null;
  btn.click();
  for (let i = 0; i < 25; i++) {
    await delay(100);
    const found = findSettingsContainer();
    if (found) return { root: found, openedNow: true };
  }
  return null;
}

/** Reads confirmation policy (`"always"` or `"never"`) from the settings root. */
function readConfirmationPolicy(root: HTMLElement): ConfirmPolicy {
  const select = root.querySelector<HTMLSelectElement>(
    'select[data-setting="confirm_before_generating"], select[data-setting="confirmation_policy"], select[name="confirm_before_generating"], select[name="confirmation_policy"]',
  );
  if (select) return /never|auto/i.test(select.value) ? "never" : "always";
  const checkedRadio = root.querySelector<HTMLInputElement>(
    'input[type="radio"][name*="confirm" i]:checked, input[type="radio"][name*="policy" i]:checked',
  );
  if (checkedRadio) {
    const val = `${checkedRadio.value} ${checkedRadio.getAttribute("aria-label") || ""}`;
    return /never|auto/i.test(val) ? "never" : "always";
  }
  const activeBtn = Array.from(
    root.querySelectorAll<HTMLElement>(
      '[data-policy][aria-pressed="true"], [data-policy][aria-checked="true"], [data-policy].active, [role="radio"][aria-checked="true"]',
    ),
  ).find((el) => el.getClientRects().length > 0);
  if (activeBtn) {
    const val = `${activeBtn.getAttribute("data-policy") || ""} ${elText(activeBtn)}`;
    return /never|auto/i.test(val) ? "never" : "always";
  }
  const toggle = root.querySelector<HTMLElement>(
    '[data-setting="confirm_before_generating"][role="switch"], [data-setting="confirmation_policy"][role="switch"], input[type="checkbox"][data-setting="confirm_before_generating"], input[type="checkbox"][data-setting="confirmation_policy"]',
  );
  if (toggle instanceof HTMLInputElement) return toggle.checked ? "always" : "never";
  if (toggle?.getAttribute("aria-checked") === "false") return "never";
  return "always";
}

/** Updates confirmation policy in the settings root. */
async function writeConfirmationPolicy(root: HTMLElement, policy: ConfirmPolicy): Promise<boolean> {
  const select = root.querySelector<HTMLSelectElement>(
    'select[data-setting="confirm_before_generating"], select[data-setting="confirmation_policy"], select[name="confirm_before_generating"], select[name="confirmation_policy"]',
  );
  if (select) {
    const opt = Array.from(select.options).find((o) =>
      policy === "never" ? /never|auto/i.test(`${o.value} ${o.text}`) : /always|ask/i.test(`${o.value} ${o.text}`),
    );
    if (!opt) return false;
    select.value = opt.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await delay(100);
    return true;
  }
  const targetPattern =
    policy === "never"
      ? /\b(?:never|auto[-\s]?approve|don't ask|automatic)\b/i
      : /\b(?:always|ask before|confirm)\b/i;
  const control = Array.from(
    root.querySelectorAll<HTMLElement>('button, [role="radio"], label, input[type="radio"]'),
  ).find((el) => {
    if (el.getClientRects().length === 0) return false;
    const txt = `${el.getAttribute("data-policy") || ""} ${el.getAttribute("value") || ""} ${el.getAttribute("aria-label") || ""} ${elText(el)}`;
    return targetPattern.test(txt);
  });
  if (control) {
    control.click();
    await delay(120);
    return true;
  }
  return false;
}

/** Locates the media defaults card (`"image"` or `"video"`) inside the settings root. */
function findMediaSection(root: HTMLElement, kind: "image" | "video"): HTMLElement | null {
  const direct = root.querySelector<HTMLElement>(
    `[data-media-defaults="${kind}"], [data-setting-section="${kind}"], .${kind}-defaults-card`,
  );
  if (direct) return direct;
  const headingRe = kind === "image" ? /\bimage\b/i : /\bvideo\b/i;
  for (const card of root.querySelectorAll<HTMLElement>("section, fieldset, .settings-card, .defaults-card")) {
    const heading = card.querySelector("h2, h3, h4, legend, .card-title");
    if (heading && headingRe.test(elText(heading))) return card;
  }
  return null;
}

/** Reads one media defaults section from the settings root. */
function readMediaCard(root: HTMLElement, kind: "image" | "video"): UiMediaDefaults {
  const sec = findMediaSection(root, kind);
  const defaultModel = kind === "image" ? "imagen-3" : "veo-2";
  const defaultAspect = "16:9";
  const fallbackRatios = kind === "image" ? ["16:9", "9:16", "1:1", "4:3", "3:4"] : ["16:9", "9:16"];
  if (!sec) {
    return {
      model: defaultModel,
      aspect_ratio: defaultAspect,
      output_count: kind === "image" ? 2 : 1,
      available_models: [{ id: defaultModel, name: defaultModel, aspect_ratios: fallbackRatios }],
    };
  }
  const aspectSelect = sec.querySelector<HTMLSelectElement>(
    'select[data-field="aspect_ratio"], select[name*="aspect" i]',
  );
  let aspect = sec.getAttribute("data-aspect-ratio") || defaultAspect;
  let knownRatios = fallbackRatios;
  if (aspectSelect) {
    aspect = aspectSelect.value || aspect;
    const opts = Array.from(aspectSelect.options).map((o) => o.value || o.text.trim()).filter(Boolean);
    if (opts.length > 0) knownRatios = opts;
  } else {
    const aspectBtns = Array.from(sec.querySelectorAll<HTMLElement>("[data-aspect-ratio]"));
    if (aspectBtns.length > 0) {
      knownRatios = aspectBtns.map((b) => b.getAttribute("data-aspect-ratio") || elText(b).trim()).filter(Boolean);
      const activeAspect = aspectBtns.find(
        (b) => b.getAttribute("aria-pressed") === "true" || b.classList.contains("active"),
      );
      if (activeAspect) aspect = activeAspect.getAttribute("data-aspect-ratio") || aspect;
    }
  }

  const modelSelect = sec.querySelector<HTMLSelectElement>('select[data-field="model"], select[name*="model" i]');
  let model: string | null = sec.getAttribute("data-model") || defaultModel;
  let available: Array<{ id: string; name: string; aspect_ratios: string[] }> = [];
  if (modelSelect) {
    model = modelSelect.value || defaultModel;
    available = Array.from(modelSelect.options).map((o) => ({
      id: o.value,
      name: (o.textContent || o.value).trim(),
      aspect_ratios: knownRatios,
    }));
  } else {
    const modelBtns = Array.from(sec.querySelectorAll<HTMLElement>("[data-model-id]"));
    if (modelBtns.length > 0) {
      available = modelBtns.map((b) => ({
        id: b.getAttribute("data-model-id") || elText(b).trim(),
        name: elText(b).trim() || b.getAttribute("data-model-id") || "",
        aspect_ratios: knownRatios,
      }));
      const active = modelBtns.find(
        (b) =>
          b.getAttribute("aria-pressed") === "true" ||
          b.getAttribute("aria-selected") === "true" ||
          b.classList.contains("active"),
      );
      if (active) model = active.getAttribute("data-model-id") || model;
    }
  }
  if (available.length === 0 && model) {
    available = [{ id: model, name: model, aspect_ratios: knownRatios }];
  }

  const countSelect = sec.querySelector<HTMLSelectElement | HTMLInputElement>(
    'select[data-field="output_count"], input[data-field="output_count"], select[name*="count" i], input[name*="count" i]',
  );
  let count = Number.parseInt(sec.getAttribute("data-output-count") || String(kind === "image" ? 2 : 1), 10) || 1;
  if (countSelect) {
    count = Number.parseInt(countSelect.value || "1", 10) || 1;
  } else {
    const activeCount = sec.querySelector<HTMLElement>(
      '[data-output-count][aria-pressed="true"], [data-output-count].active',
    );
    if (activeCount) count = Number.parseInt(activeCount.getAttribute("data-output-count") || "1", 10) || 1;
  }

  return { model, aspect_ratio: aspect, output_count: count, available_models: available };
}

/** Applies updates to an image or video defaults section in the settings UI. */
async function writeMediaCard(
  root: HTMLElement,
  kind: "image" | "video",
  patch: GenerationDefaultsPatch,
): Promise<string | null> {
  const sec = findMediaSection(root, kind);
  if (!sec) return `${kind}_defaults_section_not_found`;

  if (patch.model != null) {
    const want = patch.model.trim();
    const modelSelect = sec.querySelector<HTMLSelectElement>('select[data-field="model"], select[name*="model" i]');
    if (modelSelect) {
      const opt = Array.from(modelSelect.options).find(
        (o) => o.value === want || (o.textContent || "").trim().toLowerCase() === want.toLowerCase(),
      );
      if (!opt) return "invalid_agent_settings";
      modelSelect.value = opt.value;
      modelSelect.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      const btn = Array.from(sec.querySelectorAll<HTMLElement>("[data-model-id], button")).find(
        (b) =>
          b.getAttribute("data-model-id") === want ||
          elText(b).trim().toLowerCase() === want.toLowerCase(),
      );
      if (!btn) return "invalid_agent_settings";
      btn.click();
    }
    await delay(100);
  }

  if (patch.aspect_ratio != null) {
    const want = patch.aspect_ratio.trim();
    const aspectSelect = sec.querySelector<HTMLSelectElement>(
      'select[data-field="aspect_ratio"], select[name*="aspect" i]',
    );
    if (aspectSelect) {
      const opt = Array.from(aspectSelect.options).find(
        (o) => o.value === want || (o.textContent || "").includes(want),
      );
      if (!opt) return "invalid_agent_settings";
      aspectSelect.value = opt.value;
      aspectSelect.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      const btn = Array.from(sec.querySelectorAll<HTMLElement>("[data-aspect-ratio], button")).find(
        (b) => b.getAttribute("data-aspect-ratio") === want || elText(b).trim() === want,
      );
      if (!btn) return "invalid_agent_settings";
      btn.click();
    }
    await delay(100);
  }

  if (patch.output_count != null) {
    const want = String(patch.output_count);
    const countCtrl = sec.querySelector<HTMLSelectElement | HTMLInputElement>(
      'select[data-field="output_count"], input[data-field="output_count"], select[name*="count" i], input[name*="count" i]',
    );
    if (countCtrl instanceof HTMLSelectElement) {
      const opt = Array.from(countCtrl.options).find((o) => o.value === want || o.textContent?.trim() === want);
      if (!opt) return "invalid_agent_settings";
      countCtrl.value = opt.value;
      countCtrl.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (countCtrl instanceof HTMLInputElement) {
      setNativeValue(countCtrl, want, true);
    } else {
      const btn = Array.from(sec.querySelectorAll<HTMLElement>("[data-output-count], button")).find(
        (b) => b.getAttribute("data-output-count") === want || elText(b).trim() === want || elText(b).trim() === `x${want}`,
      );
      if (!btn) return "invalid_agent_settings";
      btn.click();
    }
    await delay(100);
  }
  return null;
}

/** Splits comma-separated attribute values into non-empty IDs. */
function readCsvAttr(el: Element, attr: string): string[] {
  const raw = el.getAttribute(attr);
  return raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

/** Reads memory cards from the settings root. */
function readMemories(root: HTMLElement): UiMemoryCard[] {
  const cards = root.querySelectorAll<HTMLElement>(
    "flow-agent-memory-card, .agent-memory-card, [data-memory-id]",
  );
  const out: UiMemoryCard[] = [];
  let idx = 0;
  for (const card of cards) {
    if (card.getClientRects().length === 0) continue;
    idx += 1;
    const id = card.getAttribute("data-memory-id") || card.getAttribute("data-id") || `memory-${idx}`;
    const titleEl = card.querySelector(".memory-title, [data-memory-title], h4, strong");
    const descEl = card.querySelector(".memory-description, .memory-content, [data-memory-description], [data-memory-content], p");
    const enabledToggle = card.querySelector<HTMLInputElement | HTMLElement>(
      'input[type="checkbox"][data-field="enabled"], [role="switch"][data-field="enabled"], input[type="checkbox"]',
    );
    let enabled = card.getAttribute("data-enabled") !== "false";
    if (enabledToggle instanceof HTMLInputElement) enabled = enabledToggle.checked;
    else if (enabledToggle?.getAttribute("aria-checked")) enabled = enabledToggle.getAttribute("aria-checked") !== "false";
    out.push({
      id,
      title: titleEl ? elText(titleEl).trim() : "",
      description: descEl ? elText(descEl).trim() : "",
      enabled,
      image_media_ids: readCsvAttr(card, "data-image-media-ids"),
      character_ids: readCsvAttr(card, "data-character-ids"),
      likeness_ids: readCsvAttr(card, "data-likeness-ids"),
    });
  }
  return out;
}

/** Applies a `create`, `update`, or `delete` action on Agent memory cards in the settings UI. */
async function applyMemoryChange(
  root: HTMLElement,
  memory: MemoryPatch,
): Promise<{ error?: string; memoryId?: string }> {
  if (memory.action === "create") {
    const beforeIds = new Set(readMemories(root).map((m) => m.id));
    const addBtn = Array.from(root.querySelectorAll<HTMLElement>('button, [role="button"]')).find(
      (b) =>
        isVisibleEnabled(b) &&
        /\b(?:add memory|new memory|create memory|add instruction|add note|add card)\b/i.test(
          `${b.getAttribute("aria-label") || ""} ${elText(b)}`,
        ),
    );
    if (!addBtn) return { error: "agent_memory_add_button_not_found" };
    addBtn.click();
    await delay(150);
    const formScope =
      document.querySelector<HTMLElement>('[data-memory-editor], [role="dialog"]') ?? root;
    const titleInput = formScope.querySelector<HTMLInputElement>(
      'input[data-field="memory_title"], input[data-field="title"], input[placeholder*="title" i], input[aria-label*="title" i], input[type="text"]',
    );
    const descInput = formScope.querySelector<HTMLTextAreaElement | HTMLInputElement>(
      'textarea[data-field="memory_description"], textarea[data-field="description"], textarea[data-field="memory_content"], textarea',
    );
    if (!descInput && !titleInput) return { error: "agent_memory_editor_not_found" };
    if (titleInput && memory.card.title != null) {
      titleInput.focus();
      setNativeValue(titleInput, memory.card.title, true);
    }
    if (descInput && memory.card.description != null) {
      descInput.focus();
      setNativeValue(descInput, memory.card.description, true);
    }
    const enabledToggle = formScope.querySelector<HTMLInputElement | HTMLElement>(
      'input[type="checkbox"][data-field="enabled"], [role="switch"][data-field="enabled"]',
    );
    if (enabledToggle && memory.card.enabled != null) {
      const current =
        enabledToggle instanceof HTMLInputElement
          ? enabledToggle.checked
          : enabledToggle.getAttribute("aria-checked") !== "false";
      if (current !== memory.card.enabled) enabledToggle.click();
    }
    clickButtonByRegex(/^(?:save|add|create|done)$/i, formScope);
    await delay(200);
    const freshRoot = findSettingsContainer() ?? root;
    const created = readMemories(freshRoot).find((m) => !beforeIds.has(m.id));
    return { memoryId: created?.id ?? `memory-${beforeIds.size + 1}` };
  }

  const card = Array.from(
    root.querySelectorAll<HTMLElement>("flow-agent-memory-card, .agent-memory-card, [data-memory-id]"),
  ).find(
    (c) => c.getAttribute("data-memory-id") === memory.id || c.getAttribute("data-id") === memory.id,
  );
  if (!card) return { error: "invalid_agent_settings" };

  if (memory.action === "delete") {
    const delBtn = Array.from(card.querySelectorAll<HTMLElement>('button, [role="button"]')).find(
      (b) =>
        isVisibleEnabled(b) &&
        /\b(?:delete|remove|trash)\b/i.test(`${b.getAttribute("aria-label") || ""} ${elText(b)}`),
    );
    if (!delBtn) return { error: "agent_memory_delete_button_not_found" };
    delBtn.click();
    await delay(150);
    const dialog = document.querySelector('[role="dialog"], [role="alertdialog"]');
    if (dialog) clickButtonByRegex(/^(?:delete|remove|confirm|yes)$/i, dialog);
    await delay(150);
    return { memoryId: memory.id };
  }

  const editBtn = Array.from(card.querySelectorAll<HTMLElement>('button, [role="button"]')).find(
    (b) =>
      isVisibleEnabled(b) &&
      /\b(?:edit|modify)\b/i.test(`${b.getAttribute("aria-label") || ""} ${elText(b)}`),
  );
  editBtn?.click();
  await delay(150);
  const scope =
    card.querySelector("textarea, input[type='text']")
      ? card
      : (document.querySelector<HTMLElement>('[data-memory-editor], [role="dialog"]') ?? root);
  if (memory.card.title != null) {
    const titleInput = scope.querySelector<HTMLInputElement>(
      'input[data-field="memory_title"], input[data-field="title"], input[placeholder*="title" i], input[aria-label*="title" i], input[type="text"]',
    );
    if (titleInput) {
      titleInput.focus();
      setNativeValue(titleInput, memory.card.title, true);
    }
  }
  if (memory.card.description != null) {
    const descInput = scope.querySelector<HTMLTextAreaElement | HTMLInputElement>(
      'textarea[data-field="memory_description"], textarea[data-field="description"], textarea[data-field="memory_content"], textarea',
    );
    if (!descInput) return { error: "agent_memory_editor_not_found" };
    descInput.focus();
    setNativeValue(descInput, memory.card.description, true);
  }
  if (memory.card.enabled != null) {
    const enabledToggle = scope.querySelector<HTMLInputElement | HTMLElement>(
      'input[type="checkbox"][data-field="enabled"], [role="switch"][data-field="enabled"], input[type="checkbox"]',
    );
    if (enabledToggle) {
      const current =
        enabledToggle instanceof HTMLInputElement
          ? enabledToggle.checked
          : enabledToggle.getAttribute("aria-checked") !== "false";
      if (current !== memory.card.enabled) enabledToggle.click();
    }
  }
  clickButtonByRegex(/^(?:save|update|done)$/i, scope);
  await delay(200);
  return { memoryId: memory.id };
}

/** Reads or updates Agent project settings through the workspace panel UI. */
export async function agentSettingsUiOp(
  _projectId: string,
  patch?: AgentSettingsPatch,
): Promise<Record<string, unknown>> {
  const panel = await ensureAgentPanelOpen();
  if (!panel) return { ok: false, error: "agent_panel_not_found" };

  const opened = await openSettingsView(panel);
  if (!opened) return { ok: false, error: "agent_settings_ui_not_found" };
  const { openedNow } = opened;
  let root = opened.root;
  let memoryId: string | undefined;

  try {
    if (patch) {
      uiSettingsWritePending = true;
      if (patch.confirm_before_generating != null) {
        const applied = await writeConfirmationPolicy(root, patch.confirm_before_generating);
        if (!applied) return { ok: false, error: "agent_confirmation_policy_control_not_found" };
        root = findSettingsContainer() ?? root;
      }
      if (patch.image_defaults) {
        const err = await writeMediaCard(root, "image", patch.image_defaults);
        if (err) return { ok: false, error: err };
        root = findSettingsContainer() ?? root;
      }
      if (patch.video_defaults) {
        const err = await writeMediaCard(root, "video", patch.video_defaults);
        if (err) return { ok: false, error: err };
        root = findSettingsContainer() ?? root;
      }
      if (patch.memory) {
        const memRes = await applyMemoryChange(root, patch.memory);
        if (memRes.error) return { ok: false, error: memRes.error };
        memoryId = memRes.memoryId;
        root = findSettingsContainer() ?? root;
      }
      const saveBtn = Array.from(root.querySelectorAll<HTMLElement>('button, [role="button"]')).find(
        (b) =>
          isVisibleEnabled(b) &&
          !b.closest("flow-agent-memory-card, .agent-memory-card, [data-memory-editor]") &&
          /^(?:save|apply|save settings)$/i.test((b.getAttribute("aria-label") || elText(b)).trim()),
      );
      if (saveBtn) {
        saveBtn.click();
        await delay(150);
        root = findSettingsContainer() ?? root;
      }
    }

    const settings = {
      confirm_before_generating: readConfirmationPolicy(root),
      image_defaults: readMediaCard(root, "image"),
      video_defaults: readMediaCard(root, "video"),
      memory: readMemories(root),
    };
    return patch
      ? { ok: true, confirmed: true, settings, ...(memoryId ? { memory_id: memoryId } : {}) }
      : { ok: true, settings };
  } finally {
    uiSettingsWritePending = false;
    const closeRoot = findSettingsContainer() ?? root;
    if (openedNow) {
      const closeBtn = Array.from(closeRoot.querySelectorAll<HTMLElement>('button, [role="button"]')).find(
        (b) =>
          isVisibleEnabled(b) &&
          /^(?:close|back|done|close settings)$/i.test(
            (b.getAttribute("aria-label") || elText(b)).trim(),
          ),
      );
      if (closeBtn) {
        closeBtn.click();
        await delay(100);
      } else {
        await dismissOverlay();
      }
    }
  }
}
