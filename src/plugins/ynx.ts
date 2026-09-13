// 枫雨API(玉宁熙)搜索插件;下载侧已改造为通用 lx 宿主(见 lxhost.ts,默认源 = lx/ynx-default.js)
import type { PluginCtx, SearchPlugin, SearchResultItem } from "./types";

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

export const ynxSearch: SearchPlugin = {
  kind: "search",
  id: "ynx-search",
  name: "枫雨搜索(玉宁熙)",
  defaultEnabledSources: [], // 直连搜索默认接管;枫雨搜索作备用,需手动启用(保存时有 409 互斥);mg 解析上游已坏
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
