// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Adapt the settings messages and model catalogue of a verified build.

import { readOwn } from "./angular";
import type { AgentSettingsExports, ModelCatalogue, NativeSettings } from "./agent_settings_protocol";
import type { AgentSettingsWireFormat } from "./frontend_builds";

/** Methods that return a nested settings message. */
const MESSAGE_METHODS = new Set(["PH", "QH", "rR", "sR", "clone"]);

/** Gets the native settings message from the project response. */
export function metadataSettings(response: object, wire?: AgentSettingsWireFormat): NativeSettings {
  const read = readOwn(response, wire?.metadata ?? "vn");
  if (typeof read !== "function") throw new Error("Project settings are unavailable");
  return read.call(response) as NativeSettings;
}

/** Adapts settings for the runtime and passes only native messages to Flow. */
export function agentSettingsWire(flow: AgentSettingsExports, wire?: AgentSettingsWireFormat) {
  if (!wire) return { flow, settings: (value: NativeSettings) => value };
  const format = wire;
  const originals = new WeakMap<object, object>();
  const raw = <T extends object>(data: T): T => (originals.get(data) ?? data) as T;

  /** Gives a native message the same methods as the runtime's settings types. */
  function view<T extends object>(data: T): T {
    const proxy = new Proxy(data, {
      has: (target, key) => Reflect.has(target, typeof key === "string" ? format.methods[key] ?? key : key),
      get(target, key) {
        if (typeof key !== "string" || key === "constructor") return Reflect.get(target, key);
        const method = Reflect.get(target, format.methods[key] ?? key);
        if (typeof method !== "function") return method;
        return (...args: unknown[]) => {
          const result = method.apply(target, args);
          if (key === "ML") return result.map(view);
          return MESSAGE_METHODS.has(key) ? view(result) : result;
        };
      },
    });
    originals.set(proxy, data);
    return proxy;
  }

  /** Gives the model catalogue the fields that the runtime reads. */
  function catalogue(value: unknown): ModelCatalogue | undefined {
    const groups = readOwn(value, format.groups);
    const image = readOwn(groups, format.imageModels);
    const video = readOwn(groups, format.videoModels);
    const tiers = readOwn(value, format.tierDefaults);
    if (!Array.isArray(image) || !Array.isArray(video) || typeof tiers !== "object" || !tiers) return;
    return { og: { XH: image, vo: video }, Wx: tiers };
  }

  /** Reads the settings from the project response and adapts its getters. */
  const bindings: AgentSettingsExports = {
    ...flow,
    settings: new Proxy(flow.settings, { construct: (type) => view(new type()) }),
    card: new Proxy(flow.card, { construct: (type) => view(new type()) }),
    finish: (data) => {
      const finished = flow.finish(raw(data));
      return originals.has(data) ? view(finished) : finished;
    },
    message: (data, type, field, value) => flow.message(raw(data), type, field, raw(value)),
    string: (data, field, value) => flow.string(raw(data), field, value),
    strings: (data, field, values) => flow.strings(raw(data), field, values),
    enumValue: (data, field, value) => flow.enumValue(raw(data), field, value),
    integer: (data, field, value) => flow.integer(raw(data), field, value),
    boolean: (data, field, value) => flow.boolean(raw(data), field, value),
    setCards: (memory, cards) => flow.setCards(raw(memory), cards.map(raw)),
    setMemoryEnabled: (memory, enabled) => flow.setMemoryEnabled(raw(memory), enabled),
    fetchModels: async (service) => {
      const models = catalogue(await flow.fetchModels(service));
      if (!models) throw new Error("Flow model catalogue is unavailable");
      return models;
    },
    modelOptions: ({ Mw, serviceTier, filters, locale }) => flow.modelOptions({
      [wire.families]: Mw, serviceTier,
      filters: { [wire.usages]: filters.Jl, aspectRatio: filters.aspectRatio }, locale,
    } as unknown as Parameters<AgentSettingsExports["modelOptions"]>[0]).map((option) => ({
      ...option, Zf: Reflect.get(option, wire.modelId) as string,
    })),
    defaultModel: ({ Wx, serviceTier, type }) => flow.defaultModel({
      [wire.tierDefaults]: Wx, serviceTier, type,
    } as Parameters<AgentSettingsExports["defaultModel"]>[0]),
    selectModel: ({ Nba, options }) => flow.selectModel({
      [wire.preferredModel]: Nba, options,
    }),
  };
  return { flow: bindings, settings: (value: NativeSettings) => view(value), catalogue };
}

/** Encodes a native update request through the verified descriptor. */
export function settingsRequest(flow: AgentSettingsExports, message: object, wire?: AgentSettingsWireFormat): object {
  const descriptor = new flow.rpc(flow.updateMethod);
  const encode = readOwn(descriptor, wire?.encode ?? "Db");
  if (typeof encode !== "function") throw new Error("Project settings request is unavailable");
  return encode.call(descriptor, message) as object;
}
