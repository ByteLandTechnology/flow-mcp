// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Check the build and runtime requirements of internal Flow operations.

import { isLiveLView, readOwn, resolveLView } from "./angular";
import {
  frontendBuild,
  MEDIA_RESOLVER_EXPORTS,
  MEDIA_UPLOAD_EXPORTS,
  readBuildLabel,
} from "./frontend_builds";
import type {
  AgentAttachmentFormat,
  AgentChatFormat,
  AgentSettingsFormat,
  AssetTrashFormat,
  CharacterBioFormat,
  CollectionWriteFormat,
  FrontendFormats,
  MediaResolverFormat,
  ProjectUploadFormat,
} from "./frontend_builds";
import { projectWriteChecks } from "./project_store";
import { legacyTile, pickTileUrl } from "./dom";
import { runtimeState } from "./state";
import type { FlowTile, NgLView, StoreProbeCheck, StoreProbeResult } from "./types";

/** State snapshot on one TanStack Query entry. */
export interface TanStackQueryState {
  /** Query status (`"success"`, `"pending"`, or `"error"`). */
  status?: string;
  /** Resolved query payload when `status` is `"success"`. */
  data?: unknown;
  /** True when TanStack Query marks the cache entry as invalid. */
  isInvalidated?: boolean;
}

/** Single entry in a TanStack `QueryCache`. */
export interface TanStackQueryEntry {
  /** Structured query key array, for example `["VIDEO_URLS", mediaId, false, true]`. */
  queryKey: readonly unknown[];
  /** Current state of the query. */
  state?: TanStackQueryState;
  /** Optional in-flight fetch promise when `state.status` is `"pending"`. */
  promise?: Promise<unknown>;
}

/** Subset of TanStack `QueryCache` methods used to read active media queries. */
export interface TanStackQueryCache {
  /** Returns all cached query entries. */
  getAll(): readonly TanStackQueryEntry[];
  /** Returns cached query entries matching `filters`. */
  findAll?(filters?: { queryKey?: readonly unknown[] }): readonly TanStackQueryEntry[];
}

/** Bound native media URL service, query cache, and Closure helper functions. */
export interface MediaResolverBinding {
  /** Verified format for the active build. */
  format: MediaResolverFormat;
  /** Bound Angular root media URL service (`_.RJ`). */
  service: object;
  /** Active TanStack `QueryCache` attached to `service`. */
  queryCache: TanStackQueryCache;
  /** Registers unsigned FIFE URLs on `service` (`_.NJ`). */
  registerFife: (service: object, urls: string[]) => void;
  /** Resolves an image URL via `service` (`_.OMb`). */
  resolveImage: (
    service: object,
    options: {
      mediaId: string;
      me: boolean;
      aspectRatio: number;
      Bc: number;
      signal?: AbortSignal;
    },
  ) => Promise<string>;
  /** Resolves video URLs via `service` (`_.QMb`). */
  resolveVideo: (
    service: object,
    options: {
      mediaId: string;
      me: boolean;
      de: boolean;
      signal?: AbortSignal;
    },
  ) => Promise<Record<string, unknown>>;
}

/** Host element selector list used to reach Angular Ivy views and injectors. */
const ANGULAR_HOST_SELECTOR =
  "flow-project-shell, flow-project-page, flow-character-edit-page, flow-editor-dispatcher, flow-editor-page, flow-scene-builder, router-outlet, aisandbox-root, app-root, main";

/** Returns true when `cand` exposes the TanStack `QueryCache` lookup interface. */
function isQueryCache(cand: unknown): cand is TanStackQueryCache {
  return Boolean(
    cand &&
      typeof cand === "object" &&
      typeof readOwn(cand, "getAll") === "function" &&
      (typeof readOwn(cand, "findAll") === "function" ||
        typeof readOwn(cand, "find") === "function"),
  );
}

/** Extracts a `TanStackQueryCache` from a `QueryCache` or `QueryClient` candidate. */
function extractQueryCache(cand: unknown): TanStackQueryCache | null {
  if (isQueryCache(cand)) return cand;
  const inner = readOwn(cand, "queryCache");
  if (isQueryCache(inner)) return inner;
  const getter = readOwn(cand, "getQueryCache");
  if (typeof getter === "function") {
    try {
      const viaGetter: unknown = getter.call(cand);
      if (isQueryCache(viaGetter)) return viaGetter;
    } catch {
      return null;
    }
  }
  return null;
}

/** Collects root and page Angular LViews from active DOM hosts and the view registry. */
function collectSeedLViews(): NgLView[] {
  const out: NgLView[] = [];
  const seen = new Set<NgLView>();
  for (const el of document.querySelectorAll(ANGULAR_HOST_SELECTOR)) {
    const lv = resolveLView(el);
    if (lv && isLiveLView(lv) && !seen.has(lv)) {
      seen.add(lv);
      out.push(lv);
    }
  }
  if (runtimeState.ngLViewMap instanceof Map) {
    let count = 0;
    for (const lv of runtimeState.ngLViewMap.values()) {
      if (isLiveLView(lv) && !seen.has(lv)) {
        seen.add(lv);
        out.push(lv);
        if (++count >= 64) break;
      }
    }
  }
  return out;
}

/** Locates or injects a root Angular service of class `serviceType` from live Ivy views. */
function locateAngularService(serviceType: Function): object | null {
  const seenLViews = new Set<NgLView>();
  const seenObjs = new Set<object>();
  let fallbackInjector: object | null = null;

  const inspectInjector = (injRoot: object): object | null => {
    let inj: object | null = injRoot;
    for (let depth = 0; depth < 8 && inj && typeof inj === "object"; depth += 1) {
      if (seenObjs.has(inj)) break;
      seenObjs.add(inj);
      if (!fallbackInjector && typeof readOwn(inj, "get") === "function") {
        fallbackInjector = inj;
      }
      const records = readOwn(inj, "records");
      if (records instanceof Map && records.has(serviceType)) {
        const rec = records.get(serviceType);
        if (rec && typeof rec === "object" && rec instanceof serviceType) return rec;
        const val = readOwn(rec, "value");
        if (val && typeof val === "object") return val;
      }
      const parent = readOwn(inj, "parent");
      inj = parent && typeof parent === "object" ? parent : null;
    }
    return null;
  };

  const queue: Array<[NgLView, number]> = collectSeedLViews().map((lv) => [lv, 0]);
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    const [lv, depth] = next;
    if (seenLViews.has(lv)) continue;
    seenLViews.add(lv);
    for (const slot of lv) {
      if (!slot || typeof slot !== "object" || slot instanceof Node) continue;
      if (slot instanceof serviceType) return slot;
      if (readOwn(slot, "records") instanceof Map || typeof readOwn(slot, "get") === "function") {
        const found = inspectInjector(slot);
        if (found) return found;
      }
    }
    if (depth < 6) {
      if (Array.isArray(lv[3])) queue.push([lv[3], depth + 1]);
      if (Array.isArray(lv[15])) queue.push([lv[15], depth + 1]);
    }
  }

  if (fallbackInjector) {
    const get = readOwn(fallbackInjector, "get");
    if (typeof get === "function") {
      try {
        const resolved: unknown = get.call(fallbackInjector, serviceType, null);
        if (resolved && typeof resolved === "object") return resolved;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Binds the verified native media URL service and its Closure helper functions. */
export function bindMediaResolver(
  format?: MediaResolverFormat,
): MediaResolverBinding | undefined {
  const activeFormat =
    format ?? frontendBuild(readBuildLabel())?.operations.media_resolver;
  if (!activeFormat) return undefined;
  const namespace = readOwn(window, "default_AiSandboxAngularFrontend");
  const serviceType = readOwn(namespace, activeFormat.exports.service);
  const registerFife = readOwn(namespace, activeFormat.exports.registerFife);
  const resolveImage = readOwn(namespace, activeFormat.exports.resolveImage);
  const resolveVideo = readOwn(namespace, activeFormat.exports.resolveVideo);
  if (
    typeof serviceType !== "function" ||
    typeof registerFife !== "function" ||
    typeof resolveImage !== "function" ||
    typeof resolveVideo !== "function"
  ) {
    return undefined;
  }
  const service = locateAngularService(serviceType);
  if (!service) return undefined;
  const queryCache = extractQueryCache(readOwn(service, activeFormat.queryClient));
  if (!queryCache) return undefined;
  return {
    format: activeFormat,
    service,
    queryCache,
    registerFife: registerFife as MediaResolverBinding["registerFife"],
    resolveImage: resolveImage as MediaResolverBinding["resolveImage"],
    resolveVideo: resolveVideo as MediaResolverBinding["resolveVideo"],
  };
}

/** Discovers active TanStack `QueryCache` instances across verified and unverified builds. */
export function findActiveQueryCaches(): TanStackQueryCache[] {
  const caches: TanStackQueryCache[] = [];
  const pushCache = (cand: unknown): void => {
    const qc = extractQueryCache(cand);
    if (qc && !caches.includes(qc)) {
      caches.push(qc);
    }
  };

  const binding = bindMediaResolver();
  if (binding) {
    pushCache(binding.queryCache);
  }

  const scanObjectProps = (obj: unknown, limit = 32): void => {
    if (!obj || typeof obj !== "object" || obj instanceof Node) return;
    pushCache(obj);
    if (Array.isArray(obj) || obj instanceof Map || obj instanceof Set) return;
    const keys = Object.keys(obj);
    for (let i = 0; i < keys.length && i < limit; i += 1) {
      pushCache(readOwn(obj, keys[i]));
    }
  };

  if (runtimeState.lService) {
    scanObjectProps(runtimeState.lService);
    scanObjectProps(runtimeState.lService._ap);
    scanObjectProps(runtimeState.lService._uo);
  }

  const seenInj = new Set<object>();
  const inspectInjector = (injRoot: object): void => {
    let inj: object | null = injRoot;
    for (let depth = 0; depth < 8 && inj && typeof inj === "object"; depth += 1) {
      if (seenInj.has(inj)) break;
      seenInj.add(inj);
      const records = readOwn(inj, "records");
      if (records instanceof Map) {
        for (const rec of records.values()) {
          pushCache(rec);
          const val = readOwn(rec, "value");
          scanObjectProps(val, 16);
        }
      }
      const parent = readOwn(inj, "parent");
      inj = parent && typeof parent === "object" ? parent : null;
    }
  };

  for (const lv of collectSeedLViews()) {
    for (const slot of lv) {
      if (!slot || typeof slot !== "object" || slot instanceof Node) continue;
      pushCache(slot);
      if (readOwn(slot, "records") instanceof Map || "parent" in slot) {
        inspectInjector(slot);
      } else {
        scanObjectProps(slot, 16);
      }
    }
  }

  return caches;
}

/** Compatibility failure returned before a request is sent. */
interface UnsupportedFrontend {
  /** False when the operation cannot run. */
  ok: false;
  /** Stable tool error code. */
  error: "unsupported_front_end";
  /** Build label of the active page. */
  build: string | null;
  /** Operation that needs the request format. */
  operation: keyof FrontendFormats;
  /** Build and runtime checks that failed. */
  failed_checks: StoreProbeCheck[];
}

/** Result of checking a build and runtime for an operation. */
type FrontendCompatibility<Format> = { ok: true; format: Format } | UnsupportedFrontend;

/** Adds the native fields used by the general project store. */
export function withMutationAliases(payload: Record<string, unknown>): Record<string, unknown> {
  const format = frontendBuild(readBuildLabel())?.projectStore.mutations;
  if (payload.type === "single_tile" && payload.Ve && typeof payload.Ve === "object") {
    if (!format) return { ...payload, We: payload.We ?? payload.Ve, df: payload.df ?? payload.Ve };
    const change = payload.Ve as Record<string, unknown>;
    const native = change.type === "set_video_trim_seconds" ? {
      ...change, [format.trimStart]: change.Cg, [format.trimEnd]: change.Rf,
    } : change;
    return { ...payload, [format.tileId]: payload.Xc ?? payload.Uc, [format.tileChange]: native };
  }
  if (format && payload.type === "create_scene") {
    return { ...payload, [format.sceneWorkflows]: payload.rg, [format.sceneCollection]: payload.Fc };
  }
  if (format && payload.type === "add_workflows_to_scene") {
    return { ...payload, [format.sceneId]: payload.Lc, [format.sceneWorkflows]: payload.rg };
  }
  return payload;
}

/** Returns the verified format when the build and runtime checks pass. */
function checkOperation<Operation extends keyof FrontendFormats>(
  operation: Operation,
  build: string | null,
  checks: StoreProbeCheck[],
): FrontendCompatibility<FrontendFormats[Operation]> {
  const format = frontendBuild(build)?.operations[operation];
  const failed = checks.filter(({ ok }) => !ok);
  if (format && failed.length === 0) return { ok: true, format };
  if (!format) {
    failed.unshift({
      name: "verified_build",
      ok: false,
      detail: build === null ? "Build label unavailable" : "Build has no verified format for this operation",
    });
  }
  return { ok: false, error: "unsupported_front_end", build, operation, failed_checks: failed };
}

/** Returns the Agent layout when the build and runtime checks pass. */
export function agentChatCompatibility(
  checks: StoreProbeCheck[] = [],
): FrontendCompatibility<AgentChatFormat> {
  return checkOperation("agent_chat", readBuildLabel(), checks);
}

/** Returns the verified project settings format when its checks pass. */
export function agentSettingsCompatibility(
  checks: StoreProbeCheck[] = [],
): FrontendCompatibility<AgentSettingsFormat> {
  return checkOperation("agent_settings", readBuildLabel(), checks);
}

/** Returns the Agent attachment format when the build and runtime checks pass. */
export function agentAttachmentCompatibility(
  checks: StoreProbeCheck[] = [],
): FrontendCompatibility<AgentAttachmentFormat> {
  const build = readBuildLabel();
  const format = frontendBuild(build)?.operations.agent_attachments;
  const namespace = Reflect.get(window, "default_AiSandboxAngularFrontend") ?? {};
  const exports = Object.entries(format?.exports ?? {}).map(([name, key]) => ({
    name,
    ok: typeof namespace[key] === "function",
    detail: "Agent attachment export",
  }));
  return checkOperation("agent_attachments", build, [...exports, ...checks]);
}

/** Returns the project library upload format when the native functions are available. */
export function projectUploadCompatibility(
  checks: StoreProbeCheck[] = [],
): FrontendCompatibility<ProjectUploadFormat> {
  const build = readBuildLabel();
  const format = frontendBuild(build)?.operations.project_upload;
  const namespace = Reflect.get(window, "default_AiSandboxAngularFrontend") ?? {};
  const exports = format ? [
    ...MEDIA_UPLOAD_EXPORTS.map((name) => ({
      name,
      ok: typeof namespace[format.media.exports[name]] === "function",
      detail: "Media upload export",
    })),
    {
      name: "upload_consent",
      ok: typeof namespace[format.media.consent] === "function",
      detail: "Upload consent service",
    },
    {
      name: "project_page",
      ok: typeof namespace[format.page.page] === "function",
      detail: "Project workspace class",
    },
  ] : [];
  return checkOperation("project_upload", build, [...exports, ...checks]);
}

/** Returns the collection format for the active project when its checks pass. */
export function collectionWriteCompatibility(): FrontendCompatibility<CollectionWriteFormat> {
  return checkOperation("collection_write", readBuildLabel(), projectWriteChecks("collection"));
}

/** Returns the personality update format when the project store can submit and confirm it. */
export function characterBioCompatibility(): FrontendCompatibility<CharacterBioFormat> {
  return checkOperation("character_bio", readBuildLabel(), projectWriteChecks("project"));
}

/** Returns the asset trash format when its checks pass. */
export function assetTrashCompatibility(): FrontendCompatibility<AssetTrashFormat> {
  return checkOperation("asset_trash_store", readBuildLabel(), projectWriteChecks("project"));
}

/** Returns the native media resolver format when its exports, service, and query cache are ready. */
export function mediaResolverCompatibility(
  checks: StoreProbeCheck[] = [],
): FrontendCompatibility<MediaResolverFormat> {
  const build = readBuildLabel();
  const format = frontendBuild(build)?.operations.media_resolver;
  const namespace = readOwn(window, "default_AiSandboxAngularFrontend");
  const runtimeChecks: StoreProbeCheck[] = [];
  if (format) {
    for (const name of MEDIA_RESOLVER_EXPORTS) {
      runtimeChecks.push({
        name,
        ok: typeof readOwn(namespace, format.exports[name]) === "function",
        detail: "Media resolver export",
      });
    }
    const serviceType = readOwn(namespace, format.exports.service);
    const service =
      typeof serviceType === "function" ? locateAngularService(serviceType) : null;
    runtimeChecks.push({
      name: "resolver_service",
      ok: Boolean(service),
      detail: service ? "bound" : "unavailable",
    });
    const qc = service
      ? extractQueryCache(readOwn(service, format.queryClient))
      : null;
    runtimeChecks.push({
      name: "query_cache",
      ok: Boolean(qc),
      detail: qc ? "ready" : "missing",
    });
  }
  return checkOperation("media_resolver", build, [...runtimeChecks, ...checks]);
}

/** Counts readable image and video tiles in the first 200 tiles. */
function tileLayout(tiles: Iterable<FlowTile>): StoreProbeCheck {
  let readable = 0;
  let unreadable = 0;
  let seen = 0;
  for (const raw of tiles) {
    if (++seen > 200) break;
    const kind = String(raw?.type ?? "").toUpperCase();
    if (kind !== "IMAGE" && kind !== "VIDEO") continue;
    const tile = legacyTile(raw);
    if (tile.Fb && (tile.Fb.Zc !== undefined || pickTileUrl(tile))) readable++;
    else unreadable++;
  }
  return {
    name: "tile_layout",
    ok: readable > 0 || unreadable === 0,
    detail: readable + unreadable === 0 ? "no media tiles to inspect" :
      `readable=${readable} unreadable=${unreadable}`,
  };
}

/** Checks the bound store and tile layout used by asset trash. */
function assetTrashChecks(tiles: Map<string, FlowTile> | null | undefined): StoreProbeCheck[] {
  const store = runtimeState.store;
  const checks = [
    { name: "store_bound", ok: Boolean(store), detail: store ? "bound" : "not bound" },
    {
      name: "tile_map",
      ok: tiles instanceof Map,
      detail: tiles instanceof Map ? `${tiles.size} tiles` : "missing",
    },
    {
      name: "mutator",
      ok: typeof store?.mutate === "function",
      detail: typeof store?.mutate === "function" ? "present" : "missing",
    },
  ];
  if (tiles instanceof Map) checks.push(tileLayout(tiles.values()));
  return checks;
}

/** Returns the compatibility result without the internal request format. */
function operationStatus(result: FrontendCompatibility<unknown>): {
  ok: boolean;
  failed_checks: StoreProbeCheck[];
} {
  return { ok: result.ok, failed_checks: result.ok ? [] : result.failed_checks };
}

/** Reports the general store checks and compatibility of each managed operation. */
export function probeStore(): StoreProbeResult {
  const build = readBuildLabel();
  const trashChecks = assetTrashChecks(runtimeState.store?.getTileMap());
  const views = runtimeState.ngLViewMap;
  const checks = [
    {
      name: "lview_registry",
      ok: views instanceof Map,
      detail: views ? `${views.size} views` : "not captured",
    },
    ...trashChecks,
  ];
  return {
    build,
    ok: checks.every(({ ok }) => ok),
    checks,
    operations: {
      agent_chat: operationStatus(agentChatCompatibility()),
      agent_attachments: operationStatus(agentAttachmentCompatibility()),
      agent_settings: operationStatus(agentSettingsCompatibility()),
      project_upload: operationStatus(projectUploadCompatibility()),
      collection_write: operationStatus(checkOperation("collection_write", build, projectWriteChecks("collection"))),
      character_bio: operationStatus(checkOperation("character_bio", build, projectWriteChecks("project"))),
      asset_trash_store: operationStatus(assetTrashCompatibility()),
      media_resolver: operationStatus(mediaResolverCompatibility()),
    },
  };
}
