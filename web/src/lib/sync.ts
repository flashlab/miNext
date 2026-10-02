// 浏览器实时同步 store:/api/ws 单向推送(连上先 snapshot,之后增量)。
// 约定:useSync 的选择器必须返回"稳定引用"(直接取 state 切片,勿在内部造对象),
// 否则 useSyncExternalStore 会反复触发重渲染。
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { api } from "./api";
import type { DlJob, DlPreview, GlobalSettings, PluginView, Speaker } from "./types";

export interface SyncState {
  connected: boolean;
  speakers: Speaker[];
  preview: DlPreview | null;
  jobs: DlJob[];
  plugins: PluginView[];
  shared: Record<string, string>;
  global: GlobalSettings | null;
  stats: { total: number; refreshing: boolean } | null;
}

let state: SyncState = {
  connected: false,
  speakers: [],
  preview: null,
  jobs: [],
  plugins: [],
  shared: {},
  global: null,
  stats: null,
};

const listeners = new Set<() => void>();
function notify() {
  for (const l of listeners) l();
}
function set(patch: Partial<SyncState>) {
  state = { ...state, ...patch };
  notify();
}
function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** 选择器取稳定切片,如 useSync((s) => s.speakers) */
export function useSync<T>(sel: (s: SyncState) => T): T {
  return useSyncExternalStore(subscribe, () => sel(state));
}

// ---- 键位失效通知(服务端 invalidate 事件 → 组件即时重取) ----
const invalidation = new Map<string, Set<() => void>>();
export function onInvalidate(key: string, cb: () => void): () => void {
  let bag = invalidation.get(key);
  if (!bag) {
    bag = new Set();
    invalidation.set(key, bag);
  }
  bag.add(cb);
  return () => {
    bag.delete(cb);
  };
}
function fireInvalidate(key: string) {
  const bag = invalidation.get(key);
  if (bag) for (const cb of bag) cb();
}

// ---- HTTP 重取(主动刷新 / 兜底;失败静默,等下一次) ----
async function safe<T>(fn: () => Promise<T>, apply: (d: T) => void) {
  try {
    apply(await fn());
  } catch {
    /* 忽略:兜底轮询与重连会补 */
  }
}
export function refreshSpeakers() {
  return safe(() => api.speakers(), (d) => set({ speakers: d }));
}
export function refreshPlugins() {
  return safe(() => api.plugins(), (d) => set({ plugins: d.plugins, shared: d.shared }));
}
export function refreshJobs() {
  return safe(() => api.dlJobs(), (d) => set({ jobs: d.jobs }));
}
export function refreshPreview() {
  return safe(() => api.dlPreview(), (d) => set({ preview: d.preview }));
}

// ---- WS 客户端(每标签页一条;指数退避重连,封顶 10s) ----
let ws: WebSocket | null = null;
let started = false;
let retryMs = 1000;
let sawSnapshot = false;

function handle(t: string, d0: unknown) {
  switch (t) {
    case "snapshot": {
      sawSnapshot = true;
      // 服务端 snapshot 的 plugins 字段是 {plugins, shared} 复合体,这里摊平进 store
      const d = d0 as {
        speakers?: Speaker[]; preview?: DlPreview | null; jobs?: DlJob[];
        plugins?: { plugins?: PluginView[]; shared?: Record<string, string> };
        global?: GlobalSettings | null; stats?: { total: number; refreshing: boolean } | null;
      };
      set({
        connected: true,
        speakers: Array.isArray(d.speakers) ? d.speakers : [],
        preview: d.preview ?? null,
        jobs: Array.isArray(d.jobs) ? d.jobs : [],
        plugins: Array.isArray(d.plugins?.plugins) ? d.plugins!.plugins! : [],
        shared: d.plugins?.shared ?? {},
        global: d.global ?? null,
        stats: d.stats ?? null,
      });
      break;
    }
    case "speaker": {
      const patch = d0 as { id: string } & Partial<Speaker>;
      const idx = state.speakers.findIndex((x) => x.id === patch.id);
      if (idx < 0) {
        void refreshSpeakers(); // 新实例:全量重取
        break;
      }
      const next = state.speakers.slice();
      next[idx] = { ...next[idx], ...patch };
      set({ speakers: next });
      break;
    }
    case "preview":
      set({ preview: (d0 as DlPreview | null) ?? null });
      break;
    case "jobs":
      set({ jobs: (d0 as DlJob[]) ?? [] });
      break;
    case "plugins": {
      const pl = d0 as { plugins?: PluginView[]; shared?: Record<string, string> };
      set({ plugins: Array.isArray(pl.plugins) ? pl.plugins : [], shared: pl.shared ?? {} });
      break;
    }
    case "global":
      set({ global: d as GlobalSettings });
      break;
    case "stats":
      set({ stats: d as { total: number; refreshing: boolean } });
      break;
    case "invalidate":
      fireInvalidate(String(d));
      break;
    case "ping":
      try {
        ws?.send('{"t":"pong"}'); // 保活上行(防 Bun idleTimeout 掐线)
      } catch {
        /* noop */
      }
      break;
  }
}

function schedule() {
  setTimeout(connect, retryMs);
  retryMs = Math.min(retryMs * 2, 10_000);
}

function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  try {
    ws = new WebSocket(`${proto}//${location.host}/api/ws`);
  } catch {
    schedule();
    return;
  }
  ws.onopen = () => {
    retryMs = 1000;
    set({ connected: true });
    // 快照兜底:1.5s 内没收到 snapshot 就自己拉一次
    setTimeout(() => {
      if (!sawSnapshot) void refreshSpeakers();
    }, 1500);
  };
  ws.onmessage = (ev) => {
    try {
      const m = JSON.parse(String(ev.data)) as { t: string; d: unknown };
      handle(m.t, m.d);
    } catch {
      /* 坏包忽略 */
    }
  };
  ws.onclose = () => {
    set({ connected: false });
    schedule();
  };
  ws.onerror = () => {
    try {
      ws?.close();
    } catch {
      /* noop */
    }
  };
}

/** App 挂载时调用一次(幂等):建连 + 30s speakers 兜底(覆盖物理音量/静音键这类设备无事件的变化) */
export function ensureSync() {
  if (started) return;
  started = true;
  connect();
  setInterval(() => void refreshSpeakers(), 30_000);
}

/** 事件驱动 + 低频兜底的取数钩子(替代纯轮询 usePoll) */
export function useLive<T>(
  fn: () => Promise<T>,
  opts: { fallbackMs: number; keys?: string[]; deps?: unknown[] },
) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const keysRef = useRef(opts.keys ?? []);
  keysRef.current = opts.keys ?? [];
  const fallbackMs = opts.fallbackMs;
  const deps = opts.deps ?? [];
  useEffect(() => {
    let alive = true;
    const run = () =>
      fnRef.current()
        .then((d) => alive && (setData(d), setError(null)))
        .catch((e) => alive && setError(e as Error));
    run();
    const timer = setInterval(run, fallbackMs);
    const offs = keysRef.current.map((k) => onInvalidate(k, run));
    return () => {
      alive = false;
      clearInterval(timer);
      for (const off of offs) off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error, reload: () => fnRef.current().then(setData) };
}
