// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// Convert native Agent values to the names used by the conversation code.

import type { FlowAgentExports, LiveTurn, QuestionResponder, ReplyBlock, Transport } from "./agent_protocol";

/** Maps each field used by the runtime to the name in one build. */
type Fields = Readonly<Record<string, string>>;

/** Field and method names passed between the Agent and the native store. */
export interface AgentWireFormat {
  /** Native methods for the transport, turn store, and question service. */
  methods: Fields;
  /** Request fields for a new message. */
  send: Fields;
  /** Fields for restoring saved turns. */
  hydrate: Fields;
  /** Fields for reconnecting to an active turn. */
  resume: Fields;
  /** Fields in the request to format a turn. */
  formatTurn: Fields;
  /** Fields of an active permission request. */
  permissionRequest: Fields;
  /** Fields of a plan execution request. */
  planRequest: Fields;
  /** Fields of the plan choice in a request. */
  planChoice: Fields;
  /** Fields in a question response request. */
  questionRequest: Fields;
  /** Fields of one answer in a question response. */
  answer: Fields;
  /** Fields of one live session. */
  session: Fields;
  /** Fields of one live or decoded turn. */
  turn: Fields;
  /** Fields of the streaming events in a turn. */
  stream: Fields;
  /** Fields of the decoded user message. */
  user: Fields;
  /** Fields of a character reference in a user message. */
  character: Fields;
  /** Fields of the decoded Agent reply. */
  reply: Fields;
  /** Fields of a permission card. */
  permissionCard: Fields;
  /** Fields of the credit and media counts returned with an approval request. */
  permissionSummary: Fields;
  /** Fields of a question card. */
  questionCard: Fields;
  /** Fields of one question in a card. */
  question: Fields;
  /** Fields of a question option. */
  option: Fields;
  /** Native plan field in a reply block. */
  planBlock: string;
  /** Fields of the plan metadata. */
  plan: Fields;
  /** Names of the native error codes. */
  errors: Fields;
}

/** Browser services with the field names used by the conversation code. */
interface AgentWire {
  /** Native library functions with adapted arguments and results. */
  flow: FlowAgentExports;
  /** Adapter for the native streaming service. */
  transport: Transport;
  /** Adapter for the native question service. */
  questions: QuestionResponder;
}

/** Copies an object and reads native fields under their runtime names. */
function receive(value: object, fields: Fields): Record<string, unknown> {
  return {
    ...value,
    ...Object.fromEntries(Object.entries(fields).map(([key, name]) => [key, Reflect.get(value, name)])),
  };
}

/** Copies request fields to the names in the current build. */
function send(value: object, fields: Fields): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [fields[key] ?? key, item]));
}

/** Converts permission counts to the names used by the runtime. */
function permissionSummary(value: unknown, format: AgentWireFormat) {
  if (!value || typeof value !== "object") return undefined;
  const { qsa, joa, loa } = receive(value, format.permissionSummary);
  if (typeof qsa === "number" && typeof joa === "number" && typeof loa === "number") {
    return { qsa, joa, loa };
  }
}

/** Converts the parts of a native reply that the tool uses. */
function blocks(value: unknown, format: AgentWireFormat): ReplyBlock[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((block) => {
    switch (block.type) {
      case "permission": {
        const card = receive(block.card, format.permissionCard);
        return { ...block, card: { ...card, summary: permissionSummary(card.summary, format) } };
      }
      case "question": {
        const card = receive(block.card, format.questionCard);
        const questions = (card.Qm as object[]).map((question) => {
          const data = receive(question, format.question);
          return {
            ...data,
            options: (data.options as object[]).map((option) => {
              const adapted = receive(option, format.option);
              return {
                ...adapted,
                rma: format.option.rma ? Boolean(adapted.rma) : undefined,
                recommended: format.option.recommended ? Boolean(adapted.recommended) : undefined,
              };
            }),
          };
        });
        return { ...block, card: { ...card, Qm: questions } };
      }
      case "plan":
        return { type: "plan", Gz: receive(Reflect.get(block, format.planBlock), format.plan) };
      default:
        return block;
    }
  }) as ReplyBlock[];
}

/** Returns a native method bound to its actual service instance. */
function method<T>(service: object | undefined, name: string): T | undefined {
  const value = service && Reflect.get(service, name);
  return typeof value === "function" ? value.bind(service) as T : undefined;
}

/** Converts this build's service without modifying a native object. */
export function adaptAgentWire(
  native: AgentWire,
  format: AgentWireFormat | undefined,
): AgentWire | undefined {
  if (!format) return native;
  const { flow, transport, questions } = native;
  const trackTurn = new WeakMap<LiveTurn, LiveTurn>();
  const wireTurn = (turn: LiveTurn) => trackTurn.get(turn) ?? turn;
  const turnView = (turn: LiveTurn): LiveTurn => {
    const data = receive(turn, format.turn);
    if (data.Tf && typeof data.Tf === "object") {
      const stream = receive(data.Tf, format.stream);
      data.Tf = { ...stream, Oh: blocks(stream.Oh, format) };
    }
    const view = data as unknown as LiveTurn;
    trackTurn.set(view, turn);
    return view;
  };
  const nativeStore = transport?.ka;
  const stop = method<Transport["ev"]>(transport, format.methods.stop);
  const remove = method<Transport["yL"]>(transport, format.methods.deleteSession);
  const rename = method<Transport["W1"]>(transport, format.methods.renameSession);
  const clear = method<Transport["ka"]["yL"]>(nativeStore, format.methods.clearSession);
  const requests = method<() => Map<string, object>>(nativeStore, format.methods.permissions);
  const answer = method<(value: object) => void>(questions, format.methods.answer);
  if (!stop || !remove || !rename || !clear || !requests || !answer ||
      !nativeStore || typeof nativeStore.ha !== "function" ||
      typeof transport.la !== "function" || typeof transport.sendMessage !== "function") return;

  return {
    questions: {
      OA: (request) => answer(send({
        ...request, Qj: request.Qj.map((item) => send(item, format.answer)),
      }, format.questionRequest)),
    },
    transport: {
      ha: transport.ha,
      la: () => transport.la(),
      yL: remove,
      W1: rename,
      ev: stop,
      sendMessage: (request) => transport.sendMessage(send(request, format.send) as typeof request),
      ka: {
        ha: () => ({ get: (id) => {
          const session = nativeStore.ha().get(id);
          if (!session) return undefined;
          const view = receive(session, format.session) as unknown as typeof session;
          return { Vh: view.Vh.map(turnView), xe: view.xe ? turnView(view.xe) : null };
        } }),
        Ma: () => {
          const summaries: ReturnType<Transport["ka"]["Ma"]> = new Map();
          for (const [id, value] of requests()) {
            const summary = permissionSummary(value, format);
            if (summary) summaries.set(id, summary);
          }
          return summaries;
        },
        yL: clear,
      },
    },
    flow: {
      ...flow,
      init: (_, id, projectId) => flow.init(transport, id, projectId),
      sessionList: (_, projectId) => flow.sessionList(transport, projectId),
      readSession: (_, id) => flow.readSession(transport, id),
      resume: (_, request) => flow.resume(transport, send(request, format.resume) as typeof request),
      decode: (stored) => turnView(flow.decode(stored)),
      hydrate: (_, request) => flow.hydrate(nativeStore, send({
        ...request, BF: request.BF.map(wireTurn),
      }, format.hydrate) as typeof request),
      clearLegacyRequest: (_, request) => flow.clearLegacyRequest(nativeStore, request),
      reply: (request) => {
        const [user, reply] = flow.reply(send({ ...request, turn: wireTurn(request.turn) }, format.formatTurn) as typeof request);
        const decodedUser = receive(user, format.user);
        if (Array.isArray(decodedUser.Uy)) {
          decodedUser.Uy = decodedUser.Uy.map((reference) => receive(reference, format.character));
        }
        const decodedReply = receive(reply, format.reply);
        decodedReply.Oh = blocks(decodedReply.Oh, format);
        decodedReply.jna = permissionSummary(decodedReply.jna, format);
        return [decodedUser, decodedReply] as unknown as [typeof user, typeof reply];
      },
      permission: (service, request) => flow.permission(service, send(request, format.permissionRequest) as typeof request),
      plan: (_, request) => flow.plan(transport, send({
        ...request, VE: send(request.VE, format.planChoice),
      }, format.planRequest) as typeof request),
      errors: receive(flow.errors, format.errors) as typeof flow.errors,
    },
  };
}
