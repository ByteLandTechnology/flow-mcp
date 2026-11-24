// Copyright 2026 ByteLand Technology Limited
// SPDX-License-Identifier: MIT

// MCP request types and native Flow Agent message and service types.

import type { AgentSettingsPatch } from "./agent_settings_protocol";

/** Decision on a permission request or plan. */
export type AgentDecision =
  | "approve"
  | "approve_and_remember"
  | "deny"
  | "run_full_plan"
  | "previz";

/** Arguments from the MCP tool. */
export interface AgentRequest {
  /** Operation to run. */
  action:
    | "get_settings"
    | "update_settings"
    | "list_sessions"
    | "create_session"
    | "rename_session"
    | "delete_session"
    | "list_messages"
    | "send_message"
    | "get_turn"
    | "resume"
    | "respond"
    | "stop";
  /** Project that owns the session. */
  project_id: string;
  /** Project settings to change. */
  settings?: AgentSettingsPatch | null;
  /** ID of the existing or new session. */
  session_id?: string;
  /** User message for a new turn. */
  message?: string;
  /** Project image, video, and character IDs to attach. */
  asset_ids?: string[] | null;
  /** Number of local files assigned by Chrome. */
  file_count?: number;
  /** New session title. */
  title?: string;
  /** Turn number, starting at one. */
  turn?: number;
  /** Pending action identifier. */
  action_id?: string;
  /** Permission decision or plan mode. */
  decision?: AgentDecision;
  /** Answers to questions in the current request. */
  answers?: {
    /** ID of the question. */
    question_id: string;
    /** IDs of the selected options. */
    option_ids: string[];
    /** Optional free text. */
    text?: string | null;
  }[];
  /** Maximum number of past turns to return. */
  limit?: number | null;
  /** Exclusive upper bound on returned turn numbers. */
  before_turn?: number | null;
}

/** Title and state of one session. */
export interface Session {
  /** Flow session identifier. */
  session_id: string;
  /** Current session title. */
  title: string;
  /** True when the session is in the server list. */
  persisted: boolean;
}

/** One request to the caller in an Agent turn result. */
export type PendingAction =
  | {
      type: "permission";
      action_id: string;
      image_count: number;
      video_count: number;
      credits: number;
    }
  | {
      type: "question";
      action_id: string;
      questions: {
        question_id: string;
        text: string;
        multiple: boolean;
        allows_text: boolean;
        options: {
          option_id: string;
          label: string;
          allows_text: boolean;
          recommended?: boolean;
        }[];
      }[];
    }
  | {
      type: "plan";
      action_id: string;
      title?: string;
      description?: string;
      decisions: string[];
    };

// Keep the field names that the supported front end uses.

/** Flow message handled by the front end message functions. */
type Proto = object;

/** Stored turn with its server state. */
export interface StoredTurn {
  /** Returns the server phase of the turn. */
  getState(): number;
}

/** Question and choices in a user input request. */
interface Question {
  /** Identifier of the question. */
  fk: string;
  /** Question text. */
  dt: string;
  /** Allows more than one selected option. */
  cj: boolean;
  /** Options that Flow accepts. */
  options: QuestionOption[];
}

/** Answer format of the Flow front end. */
export interface FlowAnswer {
  /** Question identifier. */
  fk: string;
  /** Selected option identifiers. */
  VN: string[];
  /** Optional answer text. */
  HY?: string;
}

/** Flow service that receives answers during a turn. */
export interface QuestionResponder {
  /** Sends answers to the specified request in a session. */
  OA(args: {
    sessionId: string;
    Ig: string;
    Qj: FlowAnswer[];
    hi: "SIDE_PANEL";
  }): void;
}

/** Option in a question that requires a user response. */
interface QuestionOption {
  /** Option ID. */
  zq: string;
  /** Option label. */
  label: string;
  /** True when the option accepts free text in older builds. */
  rma?: boolean;
  /** True when Flow marks the option as recommended. */
  recommended?: boolean;
}

/** Request for permission to generate media. */
interface PermissionCard {
  /** Request ID. */
  id: string;
  /** Source of the request. */
  source: string;
  /** User decision, when available. */
  Vz?: number;
  /** True when the request has expired. */
  Ls: boolean;
  /** True when Flow disables the request. */
  isDisabled: boolean;
  /** Media counts and credit cost. */
  summary: PermissionSummary;
}

/** Request for answers to a group of questions. */
interface QuestionCard {
  /** Request ID. */
  id: string;
  /** Questions to show to the caller. */
  Qm: Question[];
  /** Answers that the caller submits. */
  Qj?: FlowAnswer[];
  /** True when the request has expired. */
  Ls: boolean;
}

/** Plan that Flow can run or preview. */
interface PlanCard {
  /** Plan title. */
  title?: string;
  /** Plan ID. */
  XDa: string;
  /** Plan description. */
  FOa?: string;
}

/** User message decoded from a conversation turn. */
interface UserMessage {
  /** Message text. */
  text: string;
  /** Image and video references that Flow stored with the message. */
  Gh?: { mediaId: string }[];
  /** Character references that Flow stored with the message. */
  Uy?: { Nc: string }[];
}

/** Decoded Agent reply from the Flow front end. */
interface Reply {
  /** Reply text. */
  text: string;
  /** Text, actions, and other content in the reply. */
  Oh?: ReplyBlock[];
  /** ID of the Agent response. */
  ci?: string;
  /** Error code or message from Flow. */
  errorMessage?: string | number;
  /** Permission request from the legacy transport. */
  jna?: PermissionSummary;
}

/** Content item in an Agent reply. */
export type ReplyBlock =
  | { type: "text"; content: string }
  | { type: "permission"; card: PermissionCard }
  | { type: "question"; card: QuestionCard }
  | { type: "plan"; Gz: PlanCard }
  | { type: "a2ui"; round: unknown };

/** Media counts and credits from a permission request. */
interface PermissionSummary {
  /** Cost of the request in AI credits. */
  qsa: number;
  /** Number of requested images. */
  joa: number;
  /** Number of requested videos. */
  loa: number;
}

/** Turn in the front end. It can contain a partial reply. */
export interface LiveTurn {
  /** Flow error to show to the caller, when present. */
  errorMessage?: string | number;
  /** Message parts from the original Agent transport. */
  Yu: Proto[];
  /** Response events and generated media from the streaming protocol. */
  Tf?: {
    /** Events received for the current response. */
    Oh: ReplyBlock[];
    /** Media results by ID. */
    Bx: Map<string, { status: string; errorCode?: string | number }>;
  };
}

/** Flow state for one conversation. */
interface LiveSession {
  /** Past turns already loaded by the frontend. */
  Vh: LiveTurn[];
  /** Turn whose response is still open. */
  xe: LiveTurn | null;
}

/** Project-scoped Flow signal store for conversations. */
interface TurnStore {
  /** Returns all turns that this page has read or started. */
  ha(): Pick<Map<string, LiveSession>, "get">;
  /** Clears a deleted session. */
  yL(id: string): void;
  /** Returns outstanding requests from the original Agent transport. */
  Ma(): Map<string, PermissionSummary>;
}

/** Project-scoped Flow service that owns the live transport. */
export interface Transport {
  /** Current transports by session. */
  ha: Map<string, unknown>;
  /** Signals with partial and completed turns. */
  ka: TurnStore;
  /** True when the frontend does not allow another turn. */
  la(): boolean;
  /** Sends exactly one new message using the selected project and turn. */
  sendMessage(input: {
    ua: string;
    Fb: string;
    Gn: number;
    Oe: Proto;
    hi: "SIDE_PANEL";
    Aq?: number;
  }): Promise<void>;
  /** Deletes a server session. */
  yL(id: string): Promise<unknown>;
  /** Changes a server session title. */
  W1(id: string, title: string, projectId: string): Promise<unknown>;
  /** Stops the active turn. */
  ev(id: string): void;
}

/** Agent exports selected from a supported Flow build. */
export interface FlowAgentExports {
  /** Allocates a session ID with Flow's own format. */
  allocate(): Promise<{ id: string }>;
  /** Initializes the first turn's cache entry. */
  init(transport: Transport, id: string, projectId: string): void;
  /** Gets the server query for the project's session list. */
  sessionList(
    transport: Transport,
    projectId: string,
  ): { queryFn: () => Promise<Proto> };
  /** Reads one saved server session and its turns. */
  readSession(transport: Transport, id: string): Promise<Proto>;
  /** Reconnects to the last active turn. */
  resume(
    transport: Transport,
    args: { Fb: string; ua: string; BF: StoredTurn[]; TM: StoredTurn },
  ): boolean;
  /** Gets session rows from the list result. */
  rows(data: Proto): Proto[];
  /** Gets metadata from each session row. */
  metadata(data: Proto): Proto | undefined;
  /** Gets a string field from a Flow message. */
  string(data: Proto, field: number): string;
  /** Class token for the repeated turn field. */
  turnType: Proto;
  /** Reads a repeated message field. */
  turns<T extends Proto>(data: Proto, token: Proto, field: number): T[];
  /** Converts a stored turn to the turn representation used by the chat page. */
  decode(turn: StoredTurn): LiveTurn;
  /** Writes past turns to the turn store. */
  hydrate(
    store: TurnStore,
    data: { sessionId: string; BF: LiveTurn[]; hka: false; xe: null },
  ): void;
  /** Reads user and Agent messages from the same model that the chat page uses. */
  reply(args: {
    turn: LiveTurn;
    XJ: number;
    yc: boolean;
  }): [UserMessage, Reply];
  /** Sends the decision for an active permission request. */
  permission(
    service: object,
    request: { sessionId: string; Ig: string; action: number },
  ): void;
  /** Submits a follow-up that executes the selected plan. */
  plan(
    transport: Transport,
    request: {
      ua: string;
      Fb: string;
      VE: { label: string; aja: number };
      hi: "SIDE_PANEL";
    },
  ): void;
  /** Constructs a message envelope for one user turn. */
  newEnvelope(): Proto;
  /** Sets the content of the message envelope. */
  setContent(envelope: Proto, content: Proto): Proto;
  /** Returns a mutable Flow message. */
  mutable(message: Proto): Proto;
  /** Finalizes a Flow message. */
  finish(message: Proto): Proto;
  /** Constructs the content container. */
  newContent(): Proto;
  /** Sets the parts of the content container. */
  setParts(content: Proto, parts: Proto[]): Proto;
  /** Constructs a content part. */
  newPart(): Proto;
  /** Sets the text of a content part. */
  setText(part: Proto, text: string): Proto;
  /** Agent protocol error codes. */
  errors: { IC: string | number };
  /** Records an explicit decision on a legacy permission request. */
  legacyDecision(service: object, decision: number): void;
  /** Clears the previous permission card from the legacy store. */
  clearLegacyRequest(store: TurnStore, argument: { sessionId: string }): void;
  /** Reads a tool result event from a legacy response. */
  oneOf(
    message: Proto,
    token: Proto,
    field: number,
    group: Proto,
  ): Proto | undefined;
  /** Legacy event type. */
  toolEventType: Proto;
  /** Legacy event one-of fields. */
  toolEventGroup: Proto;
  /** Legacy tool result type. */
  toolResultType: Proto;
  /** Reads the rows of a legacy tool result. */
  resultItems(result: Proto): Proto[];
  /** Reads a struct field from a result row. */
  structFields(row: Proto): Map<string, Proto>;
  /** Reads a string from a struct value. */
  valueString(value: Proto): string;
}

/** Names of the frontend functions and values in an Agent layout. */
export type AgentExport = keyof FlowAgentExports;
