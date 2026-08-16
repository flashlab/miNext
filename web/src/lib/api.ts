import type { AlbumInfo, DirsInfo, LoopMode, PlayerState, Song, Speaker, SpeakerCommands } from "./types";

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
  addSpeaker: (body: { wsPort: number; name?: string; commands?: SpeakerCommands }) =>
    post("/api/speakers", body),
  updateSpeaker: (id: string, body: { name?: string; wsPort?: number; commands?: SpeakerCommands }) =>
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
};

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
