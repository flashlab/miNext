// 单台音箱的 WS 连接管理 + RPC 封装
import type { ServerWebSocket } from "bun";
import type {
  AppMessage,
  CommandResult,
  FileMonitorEvent,
  InstructionLine,
  RecognizeResultItem,
  WsResponse,
} from "./types";
import { encodeRequest, parseAppMessage } from "./types";

export interface SpeakerLinkHandlers {
  /** ASR 最终文本 */
  onInstructionText?: (text: string) => void;
  /** 小爱正在说话(SpeechSynthesizer/Speak 类事件) */
  onSpeakEvent?: () => void;
  /** 捕获到小爱的回复文本 */
  onReplyText?: (text: string) => void;
  /** 播放状态变化 */
  onPlaying?: (status: "Playing" | "Paused" | "Idle") => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
}

const REPLY_NS_HINTS = ["tts", "speechsynthesizer", "nlp", "dialog", "assistant"];
const REPLY_NAME_HINTS = ["reply", "respond", "speak"];
const REPLY_TEXT_KEYS = new Set([
  "text", "reply", "answer", "content", "tts", "say", "speech",
  "nlp_reply", "reply_text", "display_text",
]);
const REPLY_RECURSE_KEYS = new Set(["payload", "data", "results", "result", "instruction", "directives", "cards"]);

function extractCandidateTexts(value: unknown): string[] {
  if (typeof value === "string") {
    const t = value.trim();
    return t ? [t] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap(extractCandidateTexts);
  }
  if (value && typeof value === "object") {
    const out: string[] = [];
    for (const [k, item] of Object.entries(value as Record<string, unknown>)) {
      const kl = k.toLowerCase();
      if (REPLY_TEXT_KEYS.has(kl) && typeof item === "string") {
        const t = item.trim();
        if (t) out.push(t);
      }
      if (REPLY_RECURSE_KEYS.has(kl)) out.push(...extractCandidateTexts(item));
    }
    return out;
  }
  return [];
}

export class SpeakerLink {
  readonly id: string;
  name: string;
  readonly wsPort: number;

  online = false;
  lastEventAt = 0;
  lastIp = "";
  playing: "Playing" | "Paused" | "Idle" = "Idle";
  deviceInfo: { model?: string; sn?: string } = {};

  private ws: ServerWebSocket<unknown> | null = null;
  private pending = new Map<
    string,
    { resolve: (r: WsResponse) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private handlers: SpeakerLinkHandlers = {};

  constructor(id: string, name: string, wsPort: number) {
    this.id = id;
    this.name = name;
    this.wsPort = wsPort;
  }

  setHandlers(h: SpeakerLinkHandlers) {
    this.handlers = h;
  }

  /** 由 HTTP/WS 层回调 */
  attach(ws: ServerWebSocket<unknown>) {
    // 新连接替换旧连接
    if (this.ws && this.ws !== ws) {
      try { this.ws.close(); } catch { /* noop */ }
    }
    this.ws = ws;
    this.online = true;
    this.lastEventAt = Date.now();
    this.lastIp = ws.remoteAddress ?? "";
    this.handlers.onConnect?.();
  }

  detach(ws: ServerWebSocket<unknown>) {
    if (this.ws !== ws) return; // 旧连接的 close 不影响新连接
    this.ws = null;
    this.online = false;
    this.handlers.onDisconnect?.();
  }

  handleMessage(raw: string | Buffer) {
    if (typeof raw !== "string") return; // 二进制 Stream 帧不使用
    const msg: AppMessage | null = parseAppMessage(raw);
    if (!msg) return;
    this.lastEventAt = Date.now();

    if ("Response" in msg) {
      const resp = msg.Response;
      const p = this.pending.get(resp.id);
      if (p) {
        this.pending.delete(resp.id);
        clearTimeout(p.timer);
        p.resolve(resp);
      }
      return;
    }

    if ("Event" in msg) {
      this.routeEvent(msg.Event.event, msg.Event.data);
      return;
    }
    // Request(音箱调 server):目前无需支持
  }

  private routeEvent(event: string, data: unknown) {
    if (event === "instruction") {
      const fe = data as FileMonitorEvent | undefined;
      if (!fe || typeof fe !== "object" || !("NewLine" in fe)) return;
      let line: InstructionLine;
      try {
        line = JSON.parse(fe.NewLine);
      } catch {
        return;
      }
      const header = line.header ?? {};
      const payload = (line.payload ?? {}) as Record<string, unknown>;
      this.captureReply(header, payload, line);

      if (header.namespace === "SpeechRecognizer" && header.name === "RecognizeResult") {
        if (payload.is_final !== true) return;
        const results = (payload.results as RecognizeResultItem[] | undefined) ?? [];
        const text = results[0]?.text?.trim();
        if (text) this.handlers.onInstructionText?.(text);
      }
      return;
    }

    if (event === "playing") {
      const s = data as "Playing" | "Paused" | "Idle";
      if (s === "Playing" || s === "Paused" || s === "Idle") {
        this.playing = s;
        this.handlers.onPlaying?.(s);
      }
    }
  }

  /** 捕获小爱回复文本;speak 事件单独通知(用于应答打断) */
  private captureReply(
    header: { namespace?: string; name?: string },
    payload: Record<string, unknown>,
    line: InstructionLine,
  ) {
    const ns = (header.namespace ?? "").toLowerCase();
    const name = (header.name ?? "").toLowerCase();
    if (header.namespace === "SpeechRecognizer" && header.name === "RecognizeResult") return;

    const maybeReply =
      REPLY_NS_HINTS.some((h) => ns.includes(h)) || REPLY_NAME_HINTS.some((h) => name.includes(h));
    if (!maybeReply) return;

    const texts = [...extractCandidateTexts(payload), ...extractCandidateTexts(line)];
    const unique = [...new Set(texts)].filter(Boolean);
    if (unique.length) this.handlers.onReplyText?.(unique[0]);

    if (ns.includes("speechsynthesizer") && name.includes("speak")) {
      this.handlers.onSpeakEvent?.();
    }
  }

  /** run_shell RPC */
  async runShell(script: string, timeoutMs = 10_000): Promise<CommandResult> {
    if (!this.ws || !this.online) throw new Error(`音箱 ${this.id} 不在线`);
    const id = crypto.randomUUID();
    const resp = await new Promise<WsResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("run_shell 超时"));
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      this.ws!.send(encodeRequest({ id, command: "run_shell", payload: script }));
    });
    if (resp.code !== undefined && resp.code !== 0) {
      throw new Error(`run_shell 失败: ${resp.msg ?? `code=${resp.code}`}`);
    }
    return (resp.data ?? { stdout: "", stderr: "", exit_code: -1 }) as CommandResult;
  }

  private escapeShellSingleQuote(text: string) {
    return text.replace(/'/g, `'\"'\"'`);
  }

  /** ---- 音箱操作原语(全部经 run_shell) ---- */

  async speakText(text: string) {
    return this.runShell(`/usr/sbin/tts_play.sh '${this.escapeShellSingleQuote(text)}'`);
  }

  async askXiaoAi(text: string) {
    const payload = JSON.stringify({ tts: 1, nlp: 1, nlp_text: text });
    return this.runShell(`ubus call mibrain ai_service '${payload}'`);
  }

  async playUrl(url: string) {
    const payload = JSON.stringify({ url, type: 1 });
    return this.runShell(`ubus call mediaplayer player_play_url '${payload}'`);
  }

  async pausePlayback() {
    return this.runShell("mphelper pause");
  }

  async resumePlayback() {
    return this.runShell("mphelper play");
  }

  async getPlayStatus(): Promise<"playing" | "paused" | "idle"> {
    const res = await this.runShell("mphelper mute_stat");
    if (res.stdout.includes("1")) return "playing";
    if (res.stdout.includes("2")) return "paused";
    return "idle";
  }

  /** 读音量(player_get_play_status 的 info 是 JSON 字符串套娃) */
  async getVolume(): Promise<number | null> {
    const r = await this.runShell("ubus call mediaplayer player_get_play_status");
    try {
      const outer = JSON.parse(r.stdout);
      const info = typeof outer.info === "string" ? JSON.parse(outer.info) : outer.info;
      const v = info?.volume;
      return typeof v === "number" ? v : null;
    } catch {
      return null;
    }
  }

  async setVolume(volume: number) {
    return this.runShell(`ubus call mediaplayer player_set_volume '{"volume":${Math.round(volume)}}'`);
  }

  async probeDeviceInfo() {
    try {
      const [model, sn] = await Promise.all([
        this.runShell("echo $(micocfg_model)"),
        this.runShell("echo $(micocfg_sn)"),
      ]);
      this.deviceInfo = { model: model.stdout.trim(), sn: sn.stdout.trim() };
    } catch {
      /* 离线时忽略 */
    }
  }

  /** 主动断开(音箱会在 1s 后自动重连) */
  reconnect() {
    try { this.ws?.close(); } catch { /* noop */ }
  }
}
