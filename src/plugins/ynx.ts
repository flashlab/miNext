// 枫雨API(玉宁熙)插件:搜索 + 下载
// 端点形态(2026-08 实测):GET /API/{qq,wy,kw,kg,mg}music.php
//   搜索:?msg=&num=&apikey=  解析:kw/wy/kg 用 ?id=&type=,qq 用 ?mid=&type=
// 实测能力:kw 搜索+解析✅(flac档会静默降级128k) wy✅全档 qq✅(须mid参数) mg 解析上游已坏 kg 需账号进用户组
import type { DownloadPlugin, PluginCtx, ResolvedAudio, SearchPlugin, SearchResultItem } from "./types";

import { spawn } from "node:child_process";

const BASE = "https://api-v2.yuafeng.cn/API";

function apiKey(ctx: PluginCtx): string {
  const k = (ctx.getShared("ynx.apiKey") as string) ?? "";
  if (!k) throw new Error("未配置枫雨 API Key(玉宁熙插件设置)");
  return k;
}

/** 枫雨后端与 Bun fetch 客户端相性不佳(~2/3 概率报"音乐查询失败",curl 100% 稳定)——用 curl 做传输层 */
function curlGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn("curl", ["-s", "-m", "20", url], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`curl exit ${code}: ${err.slice(0, 120)}`))));
    p.on("error", reject);
  });
}

async function callOnce<T>(path: string): Promise<T> {
  const text = await curlGet(`${BASE}${path}`);
  const j = JSON.parse(text) as { code?: number; msg?: string };
  if (j.code !== 0) {
    const msg = j.msg ?? `code ${j.code}`;
    const e = new Error(`枫雨: ${msg}`) as Error & { retryable?: boolean };
    // 上游抖动(音乐查询失败/稍候再试/直链为空)可重试;鉴权类(403 用户组/apikey)不可
    if (!/用户组|apikey|访问被拒绝/i.test(msg)) e.retryable = true;
    throw e;
  }
  return j as unknown as T;
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
  const m = url.match(/\.([a-z0-9]{2,5})(?:\?|$)/i);
  return (m?.[1] ?? fallback).toLowerCase();
}

/** 各源搜索响应的列表提取 + 字段映射 */
interface YnxItem {
  num?: number;
  song?: string;
  title?: string;
  singer?: string;
  cover?: string;
  id?: string | number;
  mid?: string;
  copyrightId?: string;
  album_name?: string;
  type?: string[];
  audio?: { formatType?: string; format?: string; size?: string; fileType?: string }[];
}

function listOf(j: unknown): YnxItem[] {
  const d = (j as { data?: unknown }).data;
  if (Array.isArray(d)) return d as YnxItem[];
  if (d && typeof d === "object" && Array.isArray((d as { data?: unknown }).data))
    return (d as { data: YnxItem[] }).data;
  return [];
}

const idOf = (src: string, it: YnxItem): string =>
  src === "tx" ? String(it.mid ?? "") : src === "mg" ? String(it.copyrightId ?? it.id ?? "") : String(it.id ?? "");

const qualitiesOf = (src: string, it: YnxItem): string[] | undefined => {
  if (src === "kw" && Array.isArray(it.type)) return it.type;
  if (src === "mg" && Array.isArray(it.audio)) return it.audio.map((a) => a.formatType ?? "").filter(Boolean) as string[];
  return undefined;
};

const STATIC_QUALITIES: Record<string, string[]> = {
  wy: ["standard", "exhigh", "lossless", "hires"],
  tx: ["128k", "320k", "flac"],
  kg: ["128k", "320k", "flac"],
};

export const ynxSearch: SearchPlugin = {
  kind: "search",
  id: "ynx-search",
  name: "枫雨搜索(玉宁熙)",
  defaultEnabledSources: ["kw"], // 默认只开酷我,避免与 chksz 撞源;mg 解析上游已坏,kg 需用户组
  sources: [
    { id: "kw", name: "酷我" },
    { id: "mg", name: "咪咕" },
    { id: "wy", name: "网易云" },
    { id: "tx", name: "QQ音乐" },
    { id: "kg", name: "酷狗" },
  ],
  async search(source, query, limit, ctx) {
    const j = await call<unknown>(`/${source === "tx" ? "qq" : source}music.php?msg=${encodeURIComponent(query)}&num=${limit}&apikey=${apiKey(ctx)}`);
    return listOf(j).map((it): SearchResultItem => ({
      plugin: "ynx-search",
      source,
      id: idOf(source, it),
      title: String(it.song ?? it.title ?? ""),
      artist: String(it.singer ?? ""),
      album: String(it.album_name ?? ""),
      cover: it.cover || undefined,
      extra: qualitiesOf(source, it) ? { qualities: qualitiesOf(source, it) } : undefined,
    }));
  },
};

export const ynxDownload: DownloadPlugin = {
  kind: "download",
  id: "ynx-download",
  name: "枫雨下载(玉宁熙)",
  defaultEnabledSources: ["kw"],
  sources: [
    { id: "kw", name: "酷我" },
    { id: "mg", name: "咪咕" },
    { id: "wy", name: "网易云" },
    { id: "tx", name: "QQ音乐" },
    { id: "kg", name: "酷狗" },
  ],
  qualities: STATIC_QUALITIES, // kw/mg 的音质在搜索结果 extra.qualities 里(每歌不同)
  async resolve({ source, id, quality }, ctx): Promise<ResolvedAudio> {
    if (!id) throw new Error("枫雨下载需要搜索结果的 id");
    const ep = source === "tx" ? "qq" : source;
    const idParam = source === "tx" ? "mid" : "id";
    const j = await call<{ data?: Record<string, unknown> }>(
      `/${ep}music.php?${idParam}=${encodeURIComponent(id)}&type=${encodeURIComponent(quality ?? "")}&apikey=${apiKey(ctx)}`,
    );
    const d = (j as { data?: Record<string, unknown> }).data ?? (j as unknown as Record<string, unknown>);
    const url = String(d.music ?? "");
    if (!url || url === "0" || !/^https?:/.test(url)) throw new Error("枫雨: 直链为空(该音质不可用)");
    return {
      fileUrl: url,
      ext: extFromUrl(url),
      title: String(d.song ?? d.title ?? ""),
      artist: String(d.singer ?? ""),
      album: String(d.album_name ?? ""),
      lrc: typeof d.lyric === "string" && !d.lyric.includes("获取歌词失败") ? d.lyric : undefined,
    };
  },
};
