// 线协议类型(见 docs/protocol.md)

export interface WsEvent<T = unknown> {
  id: string;
  event: string;
  data?: T;
}

export interface WsRequest {
  id: string;
  command: string;
  payload?: unknown;
}

export interface WsResponse<T = unknown> {
  id: string;
  code?: number;
  msg?: string;
  data?: T;
}

export type AppMessage =
  | { Event: WsEvent }
  | { Request: WsRequest }
  | { Response: WsResponse };

export interface CommandResult {
  stdout: string;
  stderr: string;
  exit_code: number;
}

// instruction 事件 data 的形态
export type FileMonitorEvent = "NewFile" | { NewLine: string };

export interface InstructionHeader {
  dialog_id?: string;
  id?: string;
  name?: string;
  namespace?: string;
}

export interface RecognizeResultItem {
  text?: string;
  confidence?: number;
  [k: string]: unknown;
}

export interface InstructionLine {
  header?: InstructionHeader;
  payload?: Record<string, unknown>;
  [k: string]: unknown;
}

export function encodeRequest(req: WsRequest): string {
  return JSON.stringify({ Request: req });
}

export function parseAppMessage(text: string): AppMessage | null {
  try {
    const msg = JSON.parse(text);
    if (msg && typeof msg === "object") {
      if (msg.Event) return { Event: msg.Event };
      if (msg.Request) return { Request: msg.Request };
      if (msg.Response) return { Response: msg.Response };
    }
  } catch {
    /* ignore */
  }
  return null;
}
