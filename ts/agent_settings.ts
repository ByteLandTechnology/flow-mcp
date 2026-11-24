// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Read and update Agent settings through the project metadata service.

import { readOwn } from "./angular";
import { delay } from "./dom";
import { agentSettingsCompatibility } from "./frontend_compatibility";
import type { AgentSettingsWireFormat } from "./frontend_builds";
import { agentSettingsWire, metadataSettings, settingsRequest } from "./agent_settings_wire";
import type {
  AgentSettingsExports,
  AgentSettingsPatch,
  ConfirmPolicy,
  GenerationDefaultsPatch,
  MemoryCardFields,
  MemoryPatch,
  ModelCatalogue,
  NativeDefaults,
  NativeMemoryCard,
  NativeSettings,
} from "./agent_settings_protocol";

/** Maximum wait for cold cache queries (`CREDITS` and `PROJECT_DETAILS`). */
export const COLD_QUERY_TIMEOUT_MS = 5_000;

/** Initial grace window while Angular effects register a cold query in `queryCache`. */
const COLD_QUERY_GRACE_MS = 250;

/** Poll step while waiting for an active query cache entry to settle. */
const COLD_QUERY_POLL_MS = 50;

/** Angular injector of the live Agent page. */
export interface AgentInjector {
  /** Finds a service in the page's injection context. */
  get?: (token: unknown) => unknown;
}

/** Project and page that own the operation. */
interface SettingsContext {
  /** ID of the project to read or change. */
  projectId: string;
  /** Injector of the bound page. */
  injector: AgentInjector;
  /** Checks that the bound page still shows the same project. */
  isCurrent: () => boolean;
}

/** State of a cached query entry in the native query client. */
interface QueryState {
  /** Settlement state (`pending`, `success`, or `error`). */
  status?: string;
  /** Network activity state (`fetching`, `paused`, or `idle`). */
  fetchStatus?: string;
}

/** Native query entry in the shared query cache. */
interface SettingsQuery {
  /** Key of the cached query. */
  queryKey: unknown[];
  /** Current query state. */
  state?: QueryState;
  /** In-flight fetch promise when a request is active. */
  promise?: Promise<unknown>;
  /** Returns true when at least one observer enables this query. */
  isActive?: () => boolean;
  /** Fetches current project metadata from Flow. */
  fetch(options?: unknown, control?: { cancelRefetch: boolean }): Promise<object>;
}

/** Native cache shared by the metadata, credits, and project detail queries. */
export interface QueryClient {
  /** Returns the cached result for a full key. */
  ha?: (key: unknown[]) => unknown;
  /** Query registry. */
  queryCache?: {
    /** Finds the project query with this exact key. */
    find?: (options: { queryKey: unknown[]; exact: true }) => SettingsQuery | undefined;
  };
}

/** Model choices in the current project and account tier. */
interface ModelContext {
  /** The verified native functions and messages. */
  flow: AgentSettingsExports;
  /** The latest model catalogue available to the page. */
  catalogue?: ModelCatalogue;
  /** The current account's tier in Flow. */
  tier: number;
  /** Locale of model labels. */
  locale: string;
}

/** Media types with distinct model lists and native defaults. */
type MediaType = "image" | "video";

/** A native ratio name and its MCP label and code. */
interface Ratio {
  /** Name used by the model catalogue. */
  name: string;
  /** Display value accepted by the tool. */
  label: string;
  /** Code in the native settings message. */
  code: number;
}

/** Project settings request and checks for the returned values. */
interface PreparedUpdate {
  /** Metadata patch with only the affected fields. */
  metadata: NativeSettings;
  /** Paths that the server must apply. */
  paths: string[];
  /** Checks for the fields that the server must return. */
  verify: ((state: NativeSettings) => boolean)[];
  /** ID of the card that was changed. */
  memoryId?: string;
}

/** A request that cannot be applied to the current project settings. */
class SettingsInputError extends Error {}

/** True while a settings submission or its confirmation is in progress. */
export let settingsWritePending = false;

/** Gets the native service from the active project's injector. */
function service(injector: AgentInjector, token: unknown): unknown {
  try {
    return injector.get?.(token);
  } catch {
    return undefined;
  }
}

/** Checks the shape of a model catalogue before the page uses it. */
function isCatalogue(value: unknown): value is ModelCatalogue {
  const items = readOwn(value, "og");
  return Array.isArray(readOwn(items, "XH")) && Array.isArray(readOwn(items, "vo")) &&
    Boolean(readOwn(value, "Wx"));
}

/** Resolves the shared native `QueryClient` from the active page injector or component. */
export function resolveQueryClient(
  injector: AgentInjector,
  page?: Record<string, unknown>,
): QueryClient | undefined {
  const support = agentSettingsCompatibility();
  if (support.ok) {
    const namespace = readOwn(window, "default_AiSandboxAngularFrontend");
    const token = readOwn(namespace, support.format.exports.projectService);
    if (typeof token === "function") {
      const project = service(injector, token);
      const client = readOwn(project, support.format.queryClient) as QueryClient | undefined;
      if (typeof client?.queryCache?.find === "function") return client;
    }
  }
  for (const value of Object.values(page ?? {})) {
    if (!value || typeof value !== "object") continue;
    const direct = value as QueryClient;
    if (typeof direct.queryCache?.find === "function") return direct;
    for (const nested of Object.values(value as Record<string, unknown>)) {
      const candidate = nested as QueryClient | undefined;
      if (typeof candidate?.queryCache?.find === "function") return candidate;
    }
  }
  return undefined;
}

/** Input options for waiting on an active native cache query. */
interface QueryWaitOptions {
  /** Shared query client on the project page. */
  client: QueryClient | undefined;
  /** Exact query key to inspect in `queryCache`. */
  queryKey: unknown[];
  /** Returns true when the caller's signal value has settled. */
  ready: () => boolean;
  /** Returns true while the bound project page remains active. */
  canContinue: () => boolean;
  /** Optional signal predicate indicating that the service is still loading. */
  extraPending?: () => boolean;
  /** Optional caller deadline signal. */
  signal?: AbortSignal;
}

/** Waits for an active query key to settle or for `ready` to turn true within a bounded timeout. */
export async function waitForQuerySettlement(options: QueryWaitOptions): Promise<void> {
  const { client, queryKey, ready, canContinue, extraPending, signal } = options;
  if (ready() || !canContinue() || signal?.aborted) return;
  const start = Date.now();
  const deadline = start + COLD_QUERY_TIMEOUT_MS;
  const graceDeadline = start + COLD_QUERY_GRACE_MS;
  while (Date.now() < deadline && canContinue() && !signal?.aborted) {
    if (ready()) return;
    const query = client?.queryCache?.find?.({ queryKey, exact: true });
    const status = query?.state?.status;
    const fetchStatus = query?.state?.fetchStatus;
    const activeObserver = typeof query?.isActive === "function"
      ? query.isActive()
      : Date.now() < graceDeadline;
    const queryPending = Boolean(
      query
        ? fetchStatus === "fetching" || (status === "pending" && activeObserver)
        : client?.queryCache?.find && Date.now() < graceDeadline,
    );
    if (!queryPending && !extraPending?.()) break;
    const remaining = Math.max(1, Math.min(COLD_QUERY_POLL_MS, deadline - Date.now()));
    if (query?.promise) {
      await Promise.race([
        query.promise.then(() => undefined, () => undefined),
        delay(remaining),
      ]);
    } else {
      await delay(remaining);
    }
  }
}

/** Reads the model catalogue and the same tier that the settings panel uses. */
async function modelContext(
  flow: AgentSettingsExports,
  client: QueryClient,
  injector: AgentInjector,
  isCurrent: () => boolean,
  adaptCatalogue?: (value: unknown) => ModelCatalogue | undefined,
): Promise<ModelContext> {
  const tierService = service(injector, flow.serviceTier) as
    | { serviceTier?: () => number | undefined; isPending?: () => boolean }
    | undefined;
  const locale = service(injector, flow.locale);
  const models = service(injector, flow.modelService);
  const cached = client.ha?.(flow.modelKey);
  let catalogue = adaptCatalogue ? adaptCatalogue(cached) : cached;
  const loadCatalogue = !isCatalogue(catalogue) && models && typeof models === "object"
    ? flow.fetchModels(models).catch(() => undefined)
    : Promise.resolve(catalogue);
  const waitTier = tierService
    ? waitForQuerySettlement({
        client,
        queryKey: ["CREDITS"],
        ready: () => tierService.serviceTier?.() !== undefined,
        canContinue: isCurrent,
        extraPending: () => tierService.isPending?.() === true,
      })
    : Promise.resolve();
  const [resolvedCatalogue] = await Promise.all([loadCatalogue, waitTier]);
  catalogue = resolvedCatalogue;
  return {
    flow,
    catalogue: isCatalogue(catalogue) ? catalogue : undefined,
    tier: tierService?.serviceTier?.() ?? 1,
    locale: typeof locale === "string" ? locale : "en-US",
  };
}

/** Gets the supported ratios and their native codes for one media type. */
function ratios(flow: AgentSettingsExports, type: MediaType): Ratio[] {
  const image = type === "image";
  const names = image ? Object.keys(flow.aspectLabels) : flow.videoAspects;
  return names.map((name) => ({
    name,
    label: flow.aspectLabels[name].label,
    code: image ? flow.imageAspect(name) : flow.videoAspect(name),
  }));
}

/** Gets native model choices for the project, tier, and requested aspect ratio. */
function options({ flow, catalogue, tier, locale }: ModelContext, type: MediaType, ratio: Ratio) {
  if (!catalogue) return [];
  return flow.modelOptions({
    Mw: type === "image" ? catalogue.og.XH : catalogue.og.vo,
    serviceTier: tier,
    filters: { Jl: [1], aspectRatio: ratio.name },
    locale,
  });
}

/** Gets the saved model ID for one media type. */
function savedModel(state: NativeSettings, type: MediaType): string {
  return type === "image" ? state.PH().rR().QY() : state.PH().sR().ZY();
}

/** Gets the saved defaults message for one media type. */
function defaults(state: NativeSettings, type: MediaType): NativeDefaults {
  return type === "image" ? state.PH().rR() : state.PH().sR();
}

/** Gets the saved aspect ratio or Flow's default ratio when the project has none. */
function savedRatio(flow: AgentSettingsExports, type: MediaType, native: NativeDefaults): Ratio {
  const choices = ratios(flow, type);
  return choices.find(({ code }) => code === native.Pg()) ??
    choices.find(({ label }) => label === "16:9") ?? choices[0];
}

/** Gets the model ID that the native settings panel selects. */
function effectiveModel(models: ModelContext, type: MediaType, ratio: Ratio, saved: string): string {
  const { flow, catalogue, tier } = models;
  const fallback = catalogue && flow.defaultModel({ Wx: catalogue.Wx, serviceTier: tier, type });
  return flow.selectModel({ Nba: saved || fallback, options: options(models, type, ratio) }) ?? "";
}

/** Formats one media type's effective defaults and model choices for MCP. */
function defaultsView(state: NativeSettings, models: ModelContext, type: MediaType) {
  const native = defaults(state, type);
  const ratio = savedRatio(models.flow, type, native);
  const choices = new Map<string, { id: string; name: string; aspect_ratios: string[] }>();
  for (const aspect of ratios(models.flow, type)) {
    for (const { Zf: id, displayName: name, isDisabled } of options(models, type, aspect)) {
      if (isDisabled) continue;
      const model = choices.get(id) ?? { id, name, aspect_ratios: [] };
      model.aspect_ratios.push(aspect.label);
      choices.set(id, model);
    }
  }
  return {
    model: effectiveModel(models, type, ratio, savedModel(state, type)) || null,
    aspect_ratio: ratio.label,
    output_count: native.bz() || (type === "image" ? 2 : 1),
    available_models: [...choices.values()],
  };
}

/** Formats a memory card with its persistent ID. */
function memoryView(card: NativeMemoryCard): MemoryCardFields & { id: string } {
  return {
    id: card.getId(),
    title: card.Ww(),
    description: card.xl(),
    enabled: card.Vl(),
    image_media_ids: card.mB(),
    character_ids: card.KH(),
    likeness_ids: card.MH(),
  };
}

/** Gets Flow's effective confirmation policy. */
function confirmPolicy(state: NativeSettings): ConfirmPolicy {
  return state.NL() === 2 ? "never" : "always";
}

/** Formats the project settings returned by MCP. */
function settingsView(state: NativeSettings, models: ModelContext) {
  return {
    confirm_before_generating: confirmPolicy(state),
    image_defaults: defaultsView(state, models, "image"),
    video_defaults: defaultsView(state, models, "video"),
    memory: state.QH().ML().map(memoryView),
  };
}

/** Sets a nested native message and preserves its verified native type. */
function setMessage(flow: AgentSettingsExports, parent: object, field: number, child: object): void {
  flow.message(parent, child.constructor, field, flow.finish(child));
}

/** Changes defaults for one media type and records the fields to verify. */
function changeDefaults(
  context: ModelContext,
  update: PreparedUpdate,
  state: NativeSettings,
  type: MediaType,
  patch: GenerationDefaultsPatch,
): void {
  const { flow } = context;
  const image = type === "image";
  const native = defaults(state, type);
  const ratio = patch.aspect_ratio == null
    ? savedRatio(flow, type, native)
    : ratios(flow, type).find(({ label }) => label === patch.aspect_ratio?.trim());
  if (!ratio) throw new SettingsInputError(`Unsupported ${type} aspect ratio: ${patch.aspect_ratio}`);
  const model = patch.model?.trim();
  if (model != null || patch.aspect_ratio != null) {
    if (!context.catalogue) throw new SettingsInputError("Flow model catalogue is unavailable");
    const selected = model ?? effectiveModel(
      context, type, savedRatio(flow, type, native), savedModel(state, type),
    );
    if (!options(context, type, ratio).some((option) => option.Zf === selected && !option.isDisabled)) {
      throw new SettingsInputError(`Select an available ${type} model for ${ratio.label}`);
    }
  }
  const generation = update.metadata.PH().clone();
  const changed = image ? state.PH().rR().clone() : state.PH().sR().clone();
  if (model != null) {
    if ("YN" in changed) changed.YN(model);
    else changed.cO(model);
    update.verify.push((fresh) => savedModel(fresh, type) === model);
  }
  if (patch.aspect_ratio != null) {
    changed.setAspectRatio(ratio.code);
    update.verify.push((fresh) => defaults(fresh, type).Pg() === ratio.code);
  }
  const count = patch.output_count;
  if (count != null) {
    flow.integer(changed, 3, count);
    update.verify.push((fresh) => defaults(fresh, type).bz() === count);
  }
  setMessage(flow, generation, image ? 1 : 2, changed);
  setMessage(flow, update.metadata, 3, generation);
  update.paths.push(`default_generation_settings.${type}_defaults`);
}

/** Updates one card and preserves any fields outside the request. */
function changeMemory(
  flow: AgentSettingsExports,
  update: PreparedUpdate,
  state: NativeSettings,
  patch: MemoryPatch,
): void {
  const memory = state.QH().clone();
  const cards = [...memory.ML()];
  const id = patch.action === "create" ? crypto.randomUUID() : patch.id;
  const index = cards.findIndex((card) => card.getId() === id);
  if (patch.action !== "create" && index < 0) throw new SettingsInputError("Memory card not found");
  if (patch.action === "delete") {
    cards.splice(index, 1);
  } else {
    const card = patch.action === "create" ? new flow.card() : cards[index].clone();
    const fields = patch.card;
    if (patch.action === "create") flow.string(card, 1, id);
    if (fields.title != null) flow.string(card, 2, fields.title);
    if (fields.description != null) flow.string(card, 3, fields.description);
    if (fields.enabled != null || patch.action === "create") flow.boolean(card, 4, fields.enabled ?? true);
    if (fields.image_media_ids != null) flow.strings(card, 5, [...new Set(fields.image_media_ids)]);
    if (fields.character_ids != null) flow.strings(card, 6, [...new Set(fields.character_ids)]);
    if (fields.likeness_ids != null) flow.strings(card, 7, [...new Set(fields.likeness_ids)]);
    if (patch.action === "create") cards.unshift(flow.finish(card));
    else cards[index] = flow.finish(card);
  }
  const expected = cards.find((card) => card.getId() === id);
  update.verify.push((fresh) => {
    const observed = fresh.QH().ML().find((card) => card.getId() === id);
    return expected && observed
      ? JSON.stringify(memoryView(observed)) === JSON.stringify(memoryView(expected))
      : expected === observed;
  });
  flow.setMemoryEnabled(memory, cards.some((card) => card.Vl()));
  flow.setCards(memory, cards);
  setMessage(flow, update.metadata, 2, memory);
  update.paths.push("project_brief");
  update.memoryId = id;
}

/** Builds a single native patch before the browser makes a server write. */
function prepareUpdate(state: NativeSettings, models: ModelContext, patch: AgentSettingsPatch): PreparedUpdate {
  const { flow } = models;
  const update: PreparedUpdate = { metadata: new flow.settings(), paths: [], verify: [] };
  const policy = patch.confirm_before_generating;
  if (policy != null) {
    flow.enumValue(update.metadata, 4, policy === "never" ? 2 : 1);
    update.paths.push("credit_spend_approval_policy");
    update.verify.push((fresh) => confirmPolicy(fresh) === policy);
  }
  if (patch.image_defaults) changeDefaults(models, update, state, "image", patch.image_defaults);
  if (patch.video_defaults) changeDefaults(models, update, state, "video", patch.video_defaults);
  if (patch.memory) changeMemory(flow, update, state, patch.memory);
  return update;
}

/** Encodes the project name, settings, and explicit update mask. */
function encodeUpdate(
  flow: AgentSettingsExports,
  projectId: string,
  update: PreparedUpdate,
  wire?: AgentSettingsWireFormat,
): object {
  const request = new flow.request();
  const mask = flow.maskPaths(new flow.mask(), update.paths);
  flow.string(request, 1, `projects/${projectId}`);
  setMessage(flow, request, 2, update.metadata);
  setMessage(flow, request, 3, mask);
  return settingsRequest(flow, flow.finish(request), wire);
}

/** Reads or writes Agent settings on the bound project. */
export async function agentSettingsOp(context: SettingsContext, patch?: AgentSettingsPatch) {
  const support = agentSettingsCompatibility();
  if (!support.ok) return support;
  const { format } = support;
  const { injector, isCurrent, projectId } = context;
  const namespace = readOwn(window, "default_AiSandboxAngularFrontend");
  const exports = Object.fromEntries(
    Object.entries(format.exports).map(([key, name]) => [key, readOwn(namespace, name)]),
  );
  const checks = Object.entries(exports).map(([name, value]) => ({
    name,
    ok: name === "modelKey" || name === "videoAspects"
      ? Array.isArray(value)
      : name === "aspectLabels" || name === "locale" || name === "updateMethod"
        ? value !== null && typeof value === "object"
        : typeof value === "function",
    detail: "Agent settings frontend export",
  }));
  const native = exports as unknown as AgentSettingsExports;
  const project = service(injector, native.projectService);
  const client = readOwn(project, format.queryClient) as QueryClient | undefined;
  const request = readOwn(project, format.requestClient) as
    | { mutate?: (input: object) => Promise<unknown> }
    | undefined;
  checks.push({
    name: "metadata_service",
    ok: typeof client?.queryCache?.find === "function" && typeof request?.mutate === "function",
    detail: "Project metadata query and writer",
  });
  const compatibility = agentSettingsCompatibility(checks);
  if (!compatibility.ok) return compatibility;
  const { flow, settings, catalogue } = agentSettingsWire(native, format.wire);
  if (settingsWritePending) return { ok: false, error: "agent_settings_write_pending" };

  if (patch) settingsWritePending = true;
  try {
    const key = flow.projectKey(projectId);
    const find = () => client?.queryCache?.find?.({ queryKey: key, exact: true });
    let query = find();
    for (let attempt = 0; !query && attempt < 20 && isCurrent(); attempt++) {
      await delay(100);
      query = find();
    }
    if (!isCurrent()) return { ok: false, error: "agent_project_changed" };
    if (
      !query || query.queryKey[0] !== "PROJECT" || query.queryKey[1] !== projectId ||
      typeof query.fetch !== "function"
    ) {
      return { ok: false, error: "agent_settings_not_ready" };
    }
    const metadataQuery = query;
    const read = async () => settings(metadataSettings(
      await metadataQuery.fetch(undefined, { cancelRefetch: true }), format.wire,
    ));
    const state = await read();
    const models = await modelContext(flow, client ?? {}, injector, isCurrent, catalogue);
    if (!isCurrent()) return { ok: false, error: "agent_project_changed" };
    if (!patch) return { ok: true, settings: settingsView(state, models) };
    if (!request?.mutate) return { ok: false, error: "agent_settings_not_ready" };
    const update = prepareUpdate(state, models, patch);
    const payload = encodeUpdate(flow, projectId, update, format.wire);
    try {
      await request.mutate(payload);
      for (let attempt = 0; attempt < 3 && isCurrent(); attempt++) {
        const fresh = await read();
        if (isCurrent() && update.verify.every((verify) => verify(fresh))) {
          return { ok: true, confirmed: true, settings: settingsView(fresh, models), memory_id: update.memoryId };
        }
        if (attempt < 2) await delay(250);
      }
    } catch {
      // A loss of the response can occur after the server applies the update.
    }
    return {
      ok: false, error: "outcome_unknown", project_id: projectId,
      stage: "update_settings", memory_id: update.memoryId,
    };
  } catch (error) {
    if (error instanceof SettingsInputError) {
      return { ok: false, error: "invalid_agent_settings", detail: error.message };
    }
    return { ok: false, error: "agent_settings_read_failed", project_id: projectId };
  } finally {
    if (patch) settingsWritePending = false;
  }
}
