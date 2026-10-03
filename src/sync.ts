// 浏览器实时推送通道(单向:server → 浏览器;动作一律仍走 HTTP POST)
// 协议:连上先收 {t:"snapshot"} 全量,之后收增量事件:
//   speaker(部分字段) / preview / jobs / plugins / global / stats / invalidate(key) / ping
// 依赖方向:本模块不 import 任何业务模块;业务模块 import 本模块广播事件(无循环)。
import type { ServerWebSocket } from "bun";

type Client = ServerWebSocket<unknown>;
const clients = new Set<Client>();

export function addClient(ws: Client) {
  clients.add(ws);
  broadcast("clients", clients.size);
}
export function removeClient(ws: Client) {
  clients.delete(ws);
  broadcast("clients", clients.size);
}
export function clientCount(): number {
  return clients.size;
}

export function sendTo(ws: Client, t: string, d: unknown) {
  try {
    ws.send(JSON.stringify({ t, d }));
  } catch {
    /* 断连由 close 清理 */
  }
}

export function broadcast(t: string, d: unknown) {
  if (!clients.size) return;
  let msg: string;
  try {
    msg = JSON.stringify({ t, d });
  } catch {
    return;
  }
  for (const ws of clients) {
    try {
      ws.send(msg);
    } catch {
      /* 同上 */
    }
  }
}

// ---- 语义化事件 ----
export const emitSpeaker = (id: string, patch: Record<string, unknown>) => broadcast("speaker", { id, ...patch });
export const emitPreview = (d: unknown) => broadcast("preview", d);
export const emitJobs = (d: unknown) => broadcast("jobs", d);
export const emitPlugins = (d: unknown) => broadcast("plugins", d);
export const emitGlobal = (d: unknown) => broadcast("global", d);
export const emitStats = (d: unknown) => broadcast("stats", d);
export const emitInvalidate = (key: string) => broadcast("invalidate", key);
/** 服务端发起的 UI 提示(如播放失败):前端映射为 toast */
export const emitNotify = (level: "error" | "success", msg: string) => broadcast("notify", { level, msg });

/** 心跳:25s 一 ping(防 Bun idleTimeout 60s 与 NAT 断流);浏览器回 pong 保活上行 */
export function startHeartbeat(ms = 25_000) {
  const t = setInterval(() => broadcast("ping", Date.now()), ms);
  return () => clearInterval(t);
}
