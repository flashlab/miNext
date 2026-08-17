// chksz 插件:搜索(网易/QQ/酷狗) + 下载(解析直链)
// API 文档: https://api.chksz.com/#apis (字段已真机验证 2026-08)
import type { DownloadPlugin, PluginCtx, ResolvedAudio, SearchPlugin, SearchResultItem } from "./types";

const BASE = "https://api.chksz.com";

function apikey(ctx: PluginCtx): string {
  const k = ctx.getShared("chksz.apiKey");
  if (!k) throw new Error("chksz 未配置 API Key(下载页插件设置)");
  return k;
}

async function callOnce<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(20000) });
  if (r.status === 429) throw new Error("触发 chksz 频率限制(20 次/分钟),请稍后再试");
  if (r.status === 401) throw new Error("chksz API Key 无效");
  const j = (await r.json()) as { code?: number; msg?: string };
  if (j.code !== undefined && j.code !== 200) {
    const msg = j.msg ?? `code ${j.code}`;
    const e = new Error(`chksz: ${msg}`) as Error & { retryable?: boolean };
    // 上游并发抖动会被映射成误导性的 404/未找到,标记可重试
    if (j.code === 404 || j.code === 502 || j.code === 504 || /未找到匹配/.test(msg)) e.retryable = true;
    throw e;
  }
  return j as T;
}

async function call<T>(path: string): Promise<T> {
  let lastErr: Error & { retryable?: boolean } = new Error("unreachable") as never;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await callOnce<T>(path);
    } catch (e) {
      lastErr = e as Error & { retryable?: boolean };
      if (!lastErr.retryable) throw lastErr;
      await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
    }
  }
  throw lastErr;
}

function extFromUrl(url: string, fallback = "mp3"): string {
  const m = /\.([a-z0-9]{2,5})(?:\?|$)/i.exec(url);
  return m ? m[1].toLowerCase() : fallback;
}

// ---- 搜索 ----
interface WySearchResp { data?: { songs?: { id: number; name: string; artists: string; album: string; picUrl: string; duration?: number }[] } }
interface TxSearchResp { list?: { mid: string; name: string; singer: string; album: string }[] }
interface KgSearchResp { list?: { id: string; name: string; singer: string; album: string; duration?: number }[] }

export const chkszSearch: SearchPlugin = {
  kind: "search",
  id: "chksz-search",
  name: "chksz 搜索",
  sources: [
    { id: "wy", name: "网易云" },
    { id: "tx", name: "QQ音乐" },
    { id: "kg", name: "酷狗" },
  ],
  async search(source, query, limit, ctx) {
    const key = apikey(ctx);
    const q = encodeURIComponent(query);
    if (source === "wy") {
      const j = await call<WySearchResp>(`/api/163_search?keyword=${q}&limit=${limit}&apikey=${key}`);
      return (j.data?.songs ?? []).map((s) => ({
        plugin: "chksz-search", source: "wy", id: String(s.id),
        title: s.name, artist: s.artists, album: s.album,
        duration: Math.round((s.duration ?? 0) / 1000), cover: s.picUrl ?? "",
      }));
    }
    if (source === "tx") {
      const j = await call<TxSearchResp>(`/api/qq_music?msg=${q}&num=${Math.min(limit, 50)}&apikey=${key}`);
      return (j.list ?? []).map((s) => ({
        plugin: "chksz-search", source: "tx", id: s.mid,
        title: s.name, artist: s.singer, album: s.album, duration: 0, cover: "",
      }));
    }
    if (source === "kg") {
      const j = await call<KgSearchResp>(`/api/kugou_music?msg=${q}&apikey=${key}`);
      return (j.list ?? []).slice(0, limit).map((s) => ({
        plugin: "chksz-search", source: "kg", id: s.id,
        title: s.name, artist: s.singer, album: s.album, duration: s.duration ?? 0, cover: "",
      }));
    }
    throw new Error(`未知音源: ${source}`);
  },
};

// ---- 下载 ----
interface WyResolveResp { data?: { url?: string; name?: string; artist?: string; album?: string } }
interface TxResolveResp { url?: string; cover?: string; lrc?: string }
interface KgResolveResp { url?: string; format?: string }

export const WY_QUALITIES = ["standard", "exhigh", "lossless", "hires", "jymaster", "sky", "jyeffect"];
export const SIZE_QUALITIES = ["128k", "320k", "flac", "hires", "master"];

export const chkszDownload: DownloadPlugin = {
  kind: "download",
  id: "chksz-download",
  name: "chksz 下载",
  sources: [
    { id: "wy", name: "网易云" },
    { id: "tx", name: "QQ音乐" },
    { id: "kg", name: "酷狗" },
  ],
  qualities: { wy: WY_QUALITIES, tx: SIZE_QUALITIES, kg: SIZE_QUALITIES },
  async resolve({ source, id, quality }, ctx): Promise<ResolvedAudio> {
    const key = apikey(ctx);
    if (!id) throw new Error("chksz 下载需要 id/mid");
    if (source === "wy") {
      const level = quality || "lossless";
      const j = await call<WyResolveResp>(`/api/163_music?id=${encodeURIComponent(id)}&level=${level}&apikey=${key}`);
      if (!j.data?.url) throw new Error("chksz 未返回文件地址(可能无此音质版权)");
      return { fileUrl: j.data.url, ext: extFromUrl(j.data.url, "flac"), title: j.data.name ?? "", artist: j.data.artist ?? "", album: j.data.album ?? "" };
    }
    if (source === "tx") {
      const size = quality || "flac";
      const j = await call<TxResolveResp>(`/api/qq_music?mid=${encodeURIComponent(id)}&size=${size}&apikey=${key}`);
      if (!j.url) throw new Error("chksz 未返回文件地址");
      return { fileUrl: j.url, ext: extFromUrl(j.url, "flac"), title: "", artist: "", album: "", lrc: j.lrc || undefined };
    }
    if (source === "kg") {
      const size = quality || "flac";
      const j = await call<KgResolveResp>(`/api/kugou_music?id=${encodeURIComponent(id)}&size=${size}&apikey=${key}`);
      if (!j.url) throw new Error("chksz 未返回文件地址");
      return { fileUrl: j.url, ext: j.format || extFromUrl(j.url), title: "", artist: "", album: "" };
    }
    throw new Error(`未知音源: ${source}`);
  },
};
