// 直连搜索插件:零配置无 key,与中转搜索(chksz/枫雨)按平台互斥、默认接管
// kw/wy/tx/kg = 自写直连(端点参考 listen1 历史实现,2026-09 探活验证)
// bili/yt = 移植 MusicFree 官方插件请求逻辑(bilibili 需 buvid cookie 握手防 412;yt 走 https_proxy,默认关)
import type { SearchPlugin, SearchResultItem } from "./types";
import { spawn } from "node:child_process";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36";
const MOBILE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/13.0.3 Mobile/15E148 Safari/604.1";

/** curl 子进程传输:统一超时,天然继承 https_proxy 环境变量(yt 需要) */
function curl(url: string, args: string[] = [], ua = UA): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn("curl", ["-s", "-m", "15", "-A", ua, ...args, url], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`curl exit ${code}: ${err.slice(0, 120)}`))));
    p.on("error", reject);
  });
}

async function curlJson<T>(url: string, args: string[] = [], ua = UA): Promise<T> {
  const text = await curl(url, args, ua);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`响应非 JSON(${text.slice(0, 60)})`);
  }
}

function unescapeHtml(s: string): string {
  return s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
const stripTags = (s: string) => unescapeHtml(s.replace(/<[^>]+>/g, ""));

function durationToSec(d: string | number | undefined): number {
  if (typeof d === "number") return Math.round(d);
  if (typeof d === "string" && d.trim()) {
    if (/^\d+$/.test(d.trim())) return Number(d);
    const parts = d.split(":").map(Number);
    if (parts.every((n) => !Number.isNaN(n))) return parts.reduce((a, c) => a * 60 + c, 0);
  }
  return 0;
}

// ---- 酷我:search.kuwo.cn/r.s("json" 实为单引号伪 JSON,需宽容转换) ----
interface KwItem { MUSICRID?: string; SONGNAME?: string; ARTIST?: string; ALBUM?: string; DURATION?: string }
async function searchKw(query: string, limit: number): Promise<SearchResultItem[]> {
  const url = `https://search.kuwo.cn/r.s?all=${encodeURIComponent(query)}&ft=music&itemset=web_2013&client=kt&pn=0&rn=${limit}&rformat=json&encoding=utf8`;
  const raw = await curl(url);
  let j: { abslist?: KwItem[] };
  try { j = JSON.parse(raw); } catch { j = JSON.parse(raw.replace(/'/g, '"')); }
  return (j.abslist ?? []).slice(0, limit).map((it) => ({
    plugin: "direct-search", source: "kw",
    id: (it.MUSICRID ?? "").replace(/^MUSIC_/, ""), // 与枫雨 rid 同空间,下载链直通
    title: unescapeHtml(it.SONGNAME ?? ""), artist: unescapeHtml(it.ARTIST ?? ""), album: unescapeHtml(it.ALBUM ?? ""),
    duration: durationToSec(it.DURATION), cover: "",
  })).filter((r) => r.id);
}

// ---- 网易云:music.163.com/api/search/get(老接口无需 weapi 加密) ----
interface WySong { id?: number; name?: string; artists?: { name?: string }[]; album?: { name?: string }; duration?: number }
async function searchWy(query: string, limit: number): Promise<SearchResultItem[]> {
  const j = await curlJson<{ result?: { songs?: WySong[] } }>(
    `https://music.163.com/api/search/get?s=${encodeURIComponent(query)}&type=1&limit=${limit}`);
  return (j.result?.songs ?? []).map((s) => ({
    plugin: "direct-search", source: "wy",
    id: String(s.id ?? ""), // 与 chksz 163_music?id= 同空间
    title: s.name ?? "", artist: (s.artists ?? []).map((a) => a.name ?? "").filter(Boolean).join("/"),
    album: s.album?.name ?? "", duration: Math.round((s.duration ?? 0) / 1000), cover: "",
  })).filter((r) => r.id);
}

// ---- QQ:c.y.qq.com 老搜索接口(无需 sign) ----
interface TxSong { songmid?: string; songname?: string; singer?: { name?: string }[]; albumname?: string; albummid?: string; interval?: number }
async function searchTx(query: string, limit: number): Promise<SearchResultItem[]> {
  const j = await curlJson<{ data?: { song?: { list?: TxSong[] } } }>(
    `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=${encodeURIComponent(query)}&format=json&p=1&n=${Math.min(limit, 50)}&cr=1&aggr=1`);
  return (j.data?.song?.list ?? []).map((s) => ({
    plugin: "direct-search", source: "tx",
    id: s.songmid ?? "", // 与 chksz qq_music?mid= 同空间
    title: unescapeHtml(s.songname ?? ""), artist: (s.singer ?? []).map((a) => a.name ?? "").filter(Boolean).join("/"),
    album: s.albumname ?? "", duration: s.interval ?? 0,
    cover: s.albummid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${s.albummid}.jpg` : "",
  })).filter((r) => r.id);
}

// ---- 酷狗:songsearch.kugou.com(搜索开放;播放才需用户组,不在本插件职责) ----
interface KgSong { FileHash?: string; SongName?: string; SingerName?: string; AlbumName?: string; Duration?: number; AlbumID?: string }
async function searchKg(query: string, limit: number): Promise<SearchResultItem[]> {
  const j = await curlJson<{ data?: { lists?: KgSong[] } }>(
    `https://songsearch.kugou.com/song_search_v2?keyword=${encodeURIComponent(query)}&pagesize=${limit}&page=1`);
  return (j.data?.lists ?? []).map((s) => ({
    plugin: "direct-search", source: "kg",
    id: s.FileHash ?? "", // 酷狗通用 hash;与 chksz 下载的 id 兼容性待真机比对
    title: stripTags(s.SongName ?? ""), artist: stripTags(s.SingerName ?? ""), album: s.AlbumName ?? "",
    duration: s.Duration ?? 0, cover: "",
    extra: { albumId: s.AlbumID },
  })).filter((r) => r.id);
}

// ---- 哔哩哔哩:移植 MusicFree 插件 —— 先取 buvid cookie 再搜,否则 412 ----
let biliCookie = "";
async function biliSearch(query: string, limit: number): Promise<SearchResultItem[]> {
  if (!biliCookie) {
    const spi = await curlJson<{ data?: { b_3?: string; b_4?: string } }>(
      "https://api.bilibili.com/x/frontend/finger/spi", [], MOBILE_UA);
    if (!spi.data?.b_3) throw new Error("bilibili buvid 握手失败");
    biliCookie = `buvid3=${spi.data.b_3};buvid4=${spi.data.b_4 ?? ""}`;
  }
  const j = await curlJson<{ data?: { result?: { bvid?: string; title?: string; author?: string; duration?: string; pic?: string }[] } }>(
    `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(query)}&page=1&page_size=${Math.min(limit, 20)}&platform=pc&highlight=1&single_column=0`,
    ["-H", "referer: https://search.bilibili.com/", "-H", "origin: https://search.bilibili.com",
      "-H", "accept: application/json, text/plain, */*", "-H", `cookie: ${biliCookie}`]);
  return (j.data?.result ?? []).slice(0, limit).map((it) => ({
    plugin: "direct-search", source: "bili",
    id: it.bvid ?? "",
    title: stripTags(it.title ?? ""), artist: it.author ?? "", album: "",
    duration: durationToSec(it.duration),
    cover: it.pic ? (it.pic.startsWith("//") ? `https:${it.pic}` : it.pic) : "",
  })).filter((r) => r.id);
}

// ---- YouTube:移植 MusicFree 插件 —— innertube WEB 端搜索(无需 API key,需代理) ----
async function ytSearch(query: string, limit: number): Promise<SearchResultItem[]> {
  const body = JSON.stringify({
    context: { client: { hl: "zh-CN", gl: "US", clientName: "WEB", clientVersion: "2.20231121.08.00", platform: "DESKTOP", userAgent: UA } },
    query,
  });
  const j = await curlJson<Record<string, unknown>>(
    "https://www.youtube.com/youtubei/v1/search?prettyPrint=false",
    ["-X", "POST", "-H", "Content-Type: text/plain", "--data", body]);
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const contents = ((j as any)?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents ?? []) as any[];
  const section = contents.find((c) => c.itemSectionRenderer)?.itemSectionRenderer?.contents ?? [];
  const items: SearchResultItem[] = [];
  for (const c of section) {
    const v = c.videoRenderer;
    if (!v?.videoId) continue;
    items.push({
      plugin: "direct-search", source: "yt",
      id: v.videoId,
      title: v.title?.runs?.[0]?.text ?? "", artist: v.ownerText?.runs?.[0]?.text ?? "", album: "",
      duration: durationToSec(v.lengthText?.simpleText),
      cover: v.thumbnail?.thumbnails?.[0]?.url ?? "",
    });
    if (items.length >= limit) break;
  }
  return items;
}

export const directSearch: SearchPlugin = {
  kind: "search",
  id: "direct-search",
  name: "直连搜索",
  sources: [
    { id: "kw", name: "酷我" },
    { id: "wy", name: "网易云" },
    { id: "tx", name: "QQ音乐" },
    { id: "kg", name: "酷狗" },
    { id: "bili", name: "哔哩哔哩" },
    { id: "yt", name: "YouTube" },
  ],
  defaultEnabledSources: ["kw", "wy", "tx", "kg", "bili"], // yt 默认关:无 https_proxy 必超时
  async search(source, query, limit) {
    if (source === "kw") return searchKw(query, limit);
    if (source === "wy") return searchWy(query, limit);
    if (source === "tx") return searchTx(query, limit);
    if (source === "kg") return searchKg(query, limit);
    if (source === "bili") return biliSearch(query, limit);
    if (source === "yt") return ytSearch(query, limit);
    throw new Error(`未知音源: ${source}`);
  },
};
