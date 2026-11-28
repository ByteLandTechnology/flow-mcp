// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Verified Angular edit controller descriptors and prompt payload builders by build.

import { readOwn } from "./angular";
import { readBuildLabel } from "./frontend_builds";
import type {
  PromptDocumentPayload,
  PromptTextSegment,
  StoreProbeCheck,
} from "./types";

/** Exported symbols and controller members verified for asset editing in one Flow build. */
export interface EditBuildFormat {
  /** Exported `flow-edit-image-prompt-box` class on `default_AiSandboxAngularFrontend`. */
  imagePromptBox: string;
  /** Exported `flow-scene-builder` class on `default_AiSandboxAngularFrontend`. */
  sceneBuilder: string;
  /** Exported `flow-editor-dispatcher` class on `default_AiSandboxAngularFrontend`. */
  editorDispatcher: string;
  /** Exported `flow-base-prompt-box` class on `default_AiSandboxAngularFrontend`. */
  basePromptBox: string;
  /** Exported `flow-editor-side-panel` class on `default_AiSandboxAngularFrontend`. */
  sidePanel: string;
  /** Exported function that wraps plain text into a prompt segment document. */
  promptBuilder: string;
  /** Property key holding text segments in the serialized prompt document. */
  promptSegmentsKey: "kf" | "Te" | "Oe";
  /** Child `flow-base-prompt-box` query signal on `flow-edit-image-prompt-box`. */
  imageBoxChild: string;
  /** Shared `PromptStateController` field on edit prompt boxes. */
  promptState: string;
  /** Signal reporting whether submission is disabled on edit prompt boxes. */
  submitDisabled: string;
  /** Signal reporting the disabled reason on `flow-edit-video-prompt-box`. */
  submitDisabledReason: string;
  /** Input signal holding the selected timeline clip on `flow-edit-video-prompt-box`. */
  selectedClip: string;
  /** Input signal reporting region restriction on `flow-edit-video-prompt-box`. */
  regionBlockedInput: string;
  /** Computed signal reporting active region block on `flow-edit-video-prompt-box`. */
  regionBlocked: string;
  /** Computed signal returning region restriction text on `flow-edit-video-prompt-box`. */
  regionBlockedMessage: string;
  /** Computed signal reporting excessive clip duration on `flow-edit-video-prompt-box`. */
  tooLong: string;
  /** Computed signal returning maximum duration alert text on `flow-edit-video-prompt-box`. */
  tooLongMessage: string;
  /** Computed signal reporting insufficient clip duration on `flow-edit-video-prompt-box`. */
  tooShort: string;
  /** Computed signal returning minimum duration alert text on `flow-edit-video-prompt-box`. */
  tooShortMessage: string;
  /** Computed signal reporting unsupported clip resolution on `flow-edit-video-prompt-box`. */
  resolutionBlocked: string;
  /** String field returning unsupported resolution alert text on `flow-edit-video-prompt-box`. */
  resolutionBlockedMessage: string;
  /** Input signal reporting whether the selected clip is still loading. */
  clipLoading: string;
  /** Input signal listing timeline clips on `flow-scene-timeline`. */
  timelineClips: string;
  /** Timeline selection service field on `flow-scene-timeline`. */
  timelineService: string;
  /** Writable signal holding the selected clip workflow ID on the timeline service. */
  timelineSelectedSignal: string;
  /** Read signal returning the selected clip workflow ID on the timeline service. */
  timelineSelectedRead: string;
  /** Output emitter firing when a clip is selected on `flow-scene-timeline`. */
  timelineSelectOutput: string;
}

/** Verified edit descriptors for `boq_labs-ai-sandbox-frontend_20261120.00_p0`. */
const NOVEMBER_20_EDIT_BUILD: EditBuildFormat = {
  imagePromptBox: "ZX",
  sceneBuilder: "su",
  editorDispatcher: "ru",
  basePromptBox: "UX",
  sidePanel: "H6",
  promptBuilder: "QI",
  promptSegmentsKey: "kf",
  imageBoxChild: "zr",
  promptState: "Qa",
  submitDisabled: "wf",
  submitDisabledReason: "UO",
  selectedClip: "Rn",
  regionBlockedInput: "eJa",
  regionBlocked: "lT",
  regionBlockedMessage: "iPa",
  tooLong: "ina",
  tooLongMessage: "dpb",
  tooShort: "AKa",
  tooShortMessage: "epb",
  resolutionBlocked: "nna",
  resolutionBlockedMessage: "sXa",
  clipLoading: "H_",
  timelineClips: "zh",
  timelineService: "Ef",
  timelineSelectedSignal: "la",
  timelineSelectedRead: "Ca",
  timelineSelectOutput: "WBa",
};

/** Verified edit controller formats indexed by exact Flow front-end build label. */
const VERIFIED_EDIT_BUILDS: ReadonlyMap<string, EditBuildFormat> = new Map([
  ["boq_labs-ai-sandbox-frontend_20261120.00_p0", NOVEMBER_20_EDIT_BUILD],
]);

/** Returns the verified edit controller format for `label`, or `undefined`. */
export function editBuild(label: string | null): EditBuildFormat | undefined {
  return label === null ? undefined : VERIFIED_EDIT_BUILDS.get(label);
}

/** Returns the verified edit controller format of the active page, or `undefined`. */
export function activeEditBuild(): EditBuildFormat | undefined {
  return editBuild(readBuildLabel());
}

/** Calls the verified prompt builder and checks that it returns a segment list under `key`. */
function callVerifiedPromptBuilder(
  namespace: unknown,
  builderKey: string,
  segmentsKey: string,
  sample: string,
): PromptDocumentPayload | null {
  const fn = readOwn(namespace, builderKey);
  if (typeof fn !== "function") return null;
  try {
    const built: unknown = (fn as (text: string) => unknown).call(namespace, sample);
    if (!built || typeof built !== "object") return null;
    const segments = readOwn(built, segmentsKey);
    if (!Array.isArray(segments) || segments.length === 0) return null;
    const first = segments[0];
    if (
      !first ||
      typeof first !== "object" ||
      readOwn(first, "type") !== "text" ||
      readOwn(first, "content") !== sample
    ) {
      return null;
    }
    return built as PromptDocumentPayload;
  } catch {
    return null;
  }
}

/** Returns true when `pathname` is an asset editor (`/edit/`) or scene builder (`/scene/`) route. */
export function isEditRoute(pathname = location.pathname || ""): boolean {
  return /\/(?:edit|scene)\//.test(pathname);
}

/** Builds a serialized prompt payload, using `_.QI` on edit routes and `{ Oe, Te, kf }` otherwise. */
export function buildPromptPayload(
  content: string,
  editRoute = isEditRoute(),
): PromptDocumentPayload {
  if (editRoute) {
    const format = activeEditBuild();
    if (format) {
      const namespace = readOwn(window, "default_AiSandboxAngularFrontend");
      const built = callVerifiedPromptBuilder(
        namespace,
        format.promptBuilder,
        format.promptSegmentsKey,
        content,
      );
      if (built) return built;
    }
  }
  const segments: PromptTextSegment[] = [{ type: "text", content }];
  return { Oe: segments, Te: segments, kf: segments };
}

/** Validates edit controller and prompt builder descriptors for builds in `VERIFIED_EDIT_BUILDS`. */
export function editBuildChecks(build: string | null): StoreProbeCheck[] {
  const format = editBuild(build);
  if (!format) return [];
  const namespace = readOwn(window, "default_AiSandboxAngularFrontend");
  const imageCtor = readOwn(namespace, format.imagePromptBox);
  const sceneCtor = readOwn(namespace, format.sceneBuilder);
  const promptFn = readOwn(namespace, format.promptBuilder);
  const probePayload = callVerifiedPromptBuilder(
    namespace,
    format.promptBuilder,
    format.promptSegmentsKey,
    "probe",
  );
  return [
    {
      name: "edit_image_controller",
      ok: typeof imageCtor === "function",
      detail:
        typeof imageCtor === "function"
          ? `${format.imagePromptBox} present`
          : `missing ${format.imagePromptBox}`,
    },
    {
      name: "edit_scene_controller",
      ok: typeof sceneCtor === "function",
      detail:
        typeof sceneCtor === "function"
          ? `${format.sceneBuilder} present`
          : `missing ${format.sceneBuilder}`,
    },
    {
      name: "edit_prompt_builder",
      ok: typeof promptFn === "function",
      detail:
        typeof promptFn === "function"
          ? `${format.promptBuilder} present`
          : `missing ${format.promptBuilder}`,
    },
    {
      name: "edit_prompt_segments",
      ok: probePayload !== null,
      detail:
        probePayload !== null
          ? `${format.promptSegmentsKey} verified`
          : `missing ${format.promptSegmentsKey} segments`,
    },
  ];
}
