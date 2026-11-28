// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Verified Angular symbol descriptors for multi-clip and trimmed scene exports.

/** Compiled symbol and field layout for Flow scene export RPCs on one build. */
export interface SceneExportBuildFormat {
  /** Global Closure namespace object on `window`. */
  namespace: string;
  /** Optional lazy chunk loader function on the namespace. */
  moduleLoader: string;
  /** Lazy route module ID that registers scene clip protobuf helpers. */
  projectChunk: string;
  /** Angular DI token for `ImmutableGenericDataInterface`. */
  dataToken: string;
  /** Angular video and export service constructor holding the data client. */
  videoService: string;
  /** Field on the project tiles or video service that stores the `KD` client. */
  serviceDataField: string;
  /** Unary RPC descriptor constructor (`kx`). */
  unaryDescriptorCtor: string;
  /** Symbol property marking raw RPC descriptor objects (`Zw`). */
  descriptorMarker: string;
  /** Base Closure JSPB message class (`n`). */
  protoBaseCtor: string;
  /** RPC ID that starts an asynchronous scene export job. */
  startRpcId: string;
  /** Request message constructor for `startRpcId`. */
  startRequestCtor: string;
  /** Response message constructor for `startRpcId`. */
  startResponseCtor: string;
  /** Repeated clip submessage field number on the start request. */
  startClipsField: number;
  /** Operation token submessage field number on the start response. */
  startOperationField: number;
  /** RPC ID that polls a running scene export job. */
  pollRpcId: string;
  /** Request message constructor for `pollRpcId`. */
  pollRequestCtor: string;
  /** Response message constructor for `pollRpcId`. */
  pollResponseCtor: string;
  /** Operation token submessage field number on the poll request. */
  pollOperationField: number;
  /** Method on the poll response returning the numeric job state. */
  pollStatusMethod: string;
  /** Exported MP4 byte payload field number on the poll response. */
  pollBytesField: number;
  /** Scene clip message constructor (`WBb`). */
  clipCtor: string;
  /** Helper setting the clip primary media ID on a clip message (`TBb`). */
  setClipMediaId: string;
  /** Helper setting the clip start `Duration` on a clip message (`UBb`). */
  setClipStart: string;
  /** Helper setting the clip end `Duration` on a clip message (`VBb`). */
  setClipEnd: string;
  /** Helper converting finite seconds into a frozen `Duration` message (`zK`). */
  secondsToDuration: string;
  /** Helper normalizing a media resource name (`Iq`). */
  cleanMediaId: string;
  /** Helper freezing a JSPB message (`dr`). */
  freezeMsg: string;
  /** Helper cloning or finalizing a JSPB message for wire transport (`cc`). */
  cloneMsg: string;
  /** Helper setting a repeated submessage array on a JSPB message (`mv`). */
  setRepeatedSubmessage: string;
  /** Helper setting a singular submessage field on a JSPB message (`al`). */
  setSubmessage: string;
  /** Helper reading a singular submessage field from a JSPB message (`X`). */
  getSubmessage: string;
  /** Helper reading a byte string field from a JSPB message (`iv`). */
  getBytesField: string;
  /** Helper converting a JSPB byte string wrapper into a `Uint8Array` (`Tc`). */
  bytesToUint8Array: string;
}

/** Verified scene export symbol table for `boq_labs-ai-sandbox-frontend_20261120.00_p0`. */
const NOVEMBER_20_SCENE_EXPORT: SceneExportBuildFormat = {
  namespace: "default_AiSandboxAngularFrontend",
  moduleLoader: "bn",
  projectChunk: "wO1vlb",
  dataToken: "KD",
  videoService: "bO",
  serviceDataField: "ha",
  unaryDescriptorCtor: "kx",
  descriptorMarker: "Zw",
  protoBaseCtor: "n",
  startRpcId: "GjQLTd",
  startRequestCtor: "aVa",
  startResponseCtor: "cVa",
  startClipsField: 1,
  startOperationField: 2,
  pollRpcId: "IxdSwd",
  pollRequestCtor: "XUa",
  pollResponseCtor: "ZUa",
  pollOperationField: 1,
  pollStatusMethod: "Pf",
  pollBytesField: 5,
  clipCtor: "WBb",
  setClipMediaId: "TBb",
  setClipStart: "UBb",
  setClipEnd: "VBb",
  secondsToDuration: "zK",
  cleanMediaId: "Iq",
  freezeMsg: "dr",
  cloneMsg: "cc",
  setRepeatedSubmessage: "mv",
  setSubmessage: "al",
  getSubmessage: "X",
  getBytesField: "iv",
  bytesToUint8Array: "Tc",
};

/** Verified scene export formats indexed by exact Flow build label. */
const VERIFIED_SCENE_EXPORT_BUILDS: ReadonlyMap<string, SceneExportBuildFormat> = new Map([
  ["boq_labs-ai-sandbox-frontend_20261120.00_p0", NOVEMBER_20_SCENE_EXPORT],
]);

/** Returns the verified scene export symbol format for `label`, or undefined. */
export function sceneExportFormat(label: string | null): SceneExportBuildFormat | undefined {
  return label === null ? undefined : VERIFIED_SCENE_EXPORT_BUILDS.get(label);
}
