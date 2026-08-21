import type { AlbumInfo, DirsInfo, DlJob, DlResult, LoopMode, PlayerState, PluginView, Song, Speaker, SpeakerCommands } from "./types";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, {
    headers: init?.body && !(init.body instanceof FormData) ? { "content-type": "application/json" } : undefined,
    ...init,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error ?? `${r.status}`);
  return data as T;
}

const post = <T = unknown>(path: string, body?: unknown): Promise<T> =>
  req<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

export const api = {
  speakers: () => req<Speaker[]>("/api/speakers"),
  addSpeaker: (body: { wsPort: number; name?: string; commands?: SpeakerCommands; token?: string }) =>
    post("/api/speakers", body),
  updateSpeaker: (id: string, body: { name?: string; wsPort?: number; commands?: SpeakerCommands; hidden?: boolean; token?: string }) =>
    req(`/api/speakers/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteSpeaker: (id: string) => req(`/api/speakers/${id}`, { method: "DELETE" }),
  reconnect: (id: string) => post(`/api/speakers/${id}/reconnect`),

  libraryStats: () => req<{ total: number; refreshing: boolean }>("/api/library/stats"),
  refreshLibrary: () => post("/api/library/refresh"),
  dirs: () => req<DirsInfo>("/api/library/dirs"),
  addDir: (dir: string) => post<DirsInfo & { ok: boolean }>("/api/library/dirs", { dir }),
  removeDir: (dir: string, deleteFiles = false) =>
    req<DirsInfo & { ok: boolean }>(`/api/library/dirs`, { method: "DELETE", body: JSON.stringify({ dir, deleteFiles }) }),
  setDefaultDir: (dir: string) =>
    req("/api/library/dirs/default", { method: "PUT", body: JSON.stringify({ dir }) }),

  songs: (opts: { q: string; sort?: string; order?: "asc" | "desc"; limit: number | "all"; offset: number }) => {
    const p = new URLSearchParams({ q: opts.q, limit: String(opts.limit), offset: String(opts.offset) });
    if (opts.sort) p.set("sort", opts.sort);
    if (opts.order) p.set("order", opts.order);
    return req<{ songs: Song[]; total: number }>(`/api/songs?${p}`);
  },
  albums: () => req<{ albums: AlbumInfo[] }>("/api/albums"),
  uploadSong: (file: File, dir: string) => {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("dir", dir);
    return req<{ ok: boolean; path: string }>("/api/songs/upload", { method: "POST", body: fd });
  },
  deleteSong: (path: string) => post("/api/songs/delete", { path }),
  trash: () => req<{ count: number; songs: Song[] }>("/api/trash"),
  restoreTrash: (paths: string[]) => post<{ ok: boolean; restored: number }>("/api/trash/restore", { paths }),
  purgeTrash: (paths?: string[]) => post<{ ok: boolean; purged: number }>("/api/trash/purge", paths?.length ? { paths } : {}),

  playerState: (id: string) => req<PlayerState>(`/api/player/${id}/state`),
  play: (id: string, body: { paths?: string[]; keyword?: string }) => post(`/api/player/${id}/play`, body),
  append: (id: string, paths: string[]) => post(`/api/player/${id}/append`, { paths }),
  toggle: (id: string) => post<{ ok: boolean; result: string }>(`/api/player/${id}/toggle`),
  playerAction: (id: string, action: "next" | "prev" | "random") => post(`/api/player/${id}/${action}`),
  setLoop: (id: string, mode: LoopMode) => post(`/api/player/${id}/loop`, { mode }),
  setVolume: (id: string, volume: number) => post(`/api/player/${id}/volume`, { volume }),
  setStopAfterCurrent: (id: string, on: boolean) => post(`/api/player/${id}/stop-after-current`, { on }),
  listOp: (id: string, op: "playNow" | "pinTop" | "playNext" | "remove" | "reorder", args: { index?: number; from?: number; to?: number }) =>
    post(`/api/player/${id}/list`, { op, ...args }),

  toolSay: (id: string, text: string) => post<{ ok: boolean; stdout: string }>(`/api/tools/${id}/say`, { text }),
  toolAsk: (id: string, text: string) => post<{ ok: boolean; stdout: string }>(`/api/tools/${id}/ask`, { text }),
  toolPlayUrl: (id: string, url: string) => post<{ ok: boolean; stdout: string }>(`/api/tools/${id}/play-url`, { url }),
  toolShell: (id: string, script: string) =>
    post<{ ok: boolean; stdout: string; stderr: string }>(`/api/tools/${id}/shell`, { script }),

  // ---- 插件/下载 ----
  plugins: () => req<{ plugins: PluginView[]; shared: Record<string, string> }>("/api/plugins"),
  saveShared: (key: string, value: string) =>
    req("/api/plugins/shared", { method: "PUT", body: JSON.stringify({ key, value }) }),
  savePluginSettings: (id: string, body: unknown) =>
    req(`/api/plugins/${id}/settings`, { method: "PUT", body: JSON.stringify(body) }),
  dlSearch: (q: string) =>
    req<{ results: DlResult[]; errors: { source: string; error: string }[] }>(`/api/dl/search?q=${encodeURIComponent(q)}`),
  dlDownload: (body: { source: string; id?: string; url?: string; quality?: string; dir: string; meta?: { title?: string; artist?: string; album?: string } }) =>
    post<{ ok: boolean; job: DlJob }>("/api/dl/download", body),
  libraryTree: (path: string) => req<{ path: string; dirs: string[] }>(`/api/library/tree?path=${encodeURIComponent(path)}`),
  dlResolve: (source: string, id: string) => post<{ ok: boolean; fileUrl: string }>("/api/dl/resolve", { source, id }),
  dlJobs: () => req<{ jobs: DlJob[] }>("/api/dl/jobs"),
};

/** 曲库文件的 HTTP 播放地址(服务端 /music/ 带 Range) */
export const musicUrl = (path: string) => "/music" + path.split("/").map(encodeURIComponent).join("/");

export function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function fmtTimeAgo(ts: number | null): string {
  if (!ts) return "—";
  const d = Math.floor((Date.now() - ts) / 1000);
  if (d < 60) return `${d}s 前`;
  if (d < 3600) return `${Math.floor(d / 60)}m 前`;
  return `${Math.floor(d / 3600)}h 前`;
}
