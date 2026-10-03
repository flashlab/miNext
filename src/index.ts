// miNext 入口 v2:sqlite 驱动的实例注册表 + 曲库 + HTTP
import { loadConfig, type CommandsConfig } from "./config";
import { LibraryDb } from "./library/db";
import { Indexer } from "./library/indexer";
import type { SearchSemantics } from "./library/search";
import { SpeakerRegistry } from "./registry";
import { PluginRegistry } from "./plugins/registry";
import { lxDownload } from "./plugins/lxhost";
import { startDownload } from "./jobs";
import type { UrlItem } from "./player/engine";
import type { DlActions } from "./player/voice";
import { createHttpServer } from "./http/server";
import { normalize } from "node:path";

const cfg = await loadConfig(process.env.MINEXT_CONFIG ?? "minext.config.json");

const db = new LibraryDb(cfg.dbPath);

// 曲库目录:settings 优先,首次从 config 播种
if (!db.getSettingJSON<string[]>("musicDirs")) db.setSettingJSON("musicDirs", cfg.musicDirs);
if (!db.getSetting("defaultDir")) db.setSetting("defaultDir", cfg.musicDirs[0] ?? "");
const getDirs = () => db.getSettingJSON<string[]>("musicDirs") ?? cfg.musicDirs;
const getDefaultDir = () => db.getSetting("defaultDir") ?? getDirs()[0] ?? "";

// 全局设置:命令/后缀/搜索语义。迁移:首个有实例级命令覆盖的实例提为全局,其余清空(关键词已全局化)
const spRows0 = db.listSpeakers();
if (!db.getSettingJSON("globalCommands")) {
  const override = spRows0
    .map((r) => JSON.parse(r.commands || "{}") as Partial<CommandsConfig>)
    .find((o) => Object.keys(o).length > 0);
  db.setSettingJSON("globalCommands", { ...cfg.commands, ...(override ?? {}) });
}
for (const r of spRows0) if (r.commands && r.commands !== "{}") db.updateSpeaker(r.id, { commands: "{}" });
if (!db.getSettingJSON("audioExtensions")) db.setSettingJSON("audioExtensions", cfg.audioExtensions);
if (!db.getSettingJSON("searchSem")) db.setSettingJSON("searchSem", cfg.search);

const getCommands = (): CommandsConfig =>
  ({ ...cfg.commands, ...(db.getSettingJSON<Partial<CommandsConfig>>("globalCommands") ?? {}) }) as CommandsConfig;
const getSearchSem = (): SearchSemantics => ({ ...cfg.search, ...(db.getSettingJSON<Partial<SearchSemantics>>("searchSem") ?? {}) });
const getExtensions = () => db.getSettingJSON<string[]>("audioExtensions") ?? cfg.audioExtensions;

const indexer = new Indexer(db, getDirs, getExtensions());

// 插件注册表(须早于音箱实例:语音在线搜索/下载当前试听要经 plugins)
const plugins = new PluginRegistry(db);
await lxDownload.load(plugins.ctx); // lx 源 JS 进进程级加载一次;换源 = 替换 data/lx-source.js + 重启

/** 目标目录是否在曲库路径内(与 HTTP 侧 inLibrary 同语义) */
const dirsContain = (p: string) => getDirs().some((d) => {
  const np = normalize(p);
  const nd = normalize(d).replace(/\/+$/, "");
  return np === nd || np.startsWith(nd + "/");
});

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("解析超时")), ms))]);

/** 语音在线搜索:只搜不解析(整列留在内存里;直链等播到那首/要下载时才解析,避免预解析触发上游限制) */
async function voiceSearchList(q: string): Promise<UrlItem[]> {
  const { results, errors } = await plugins.searchAll(q);
  for (const e of errors) console.log(`[voice search] 源失败 ${e.source}: ${e.error}`);
  const items: UrlItem[] = [];
  for (const r of results) {
    const source = String(r.source ?? "");
    const id = String(r.id ?? "");
    if (!source || !id) continue;
    const dur = typeof r.duration === "number" ? r.duration : 0;
    items.push({
      key: `${source}:${id}`, source, id,
      title: String(r.title ?? ""), artist: String(r.artist ?? ""),
      album: r.album ? String(r.album) : undefined,
      duration: dur > 0 ? dur : 0,
    });
  }
  console.log(`[voice search] "${q}": ${items.length} 条结果(直链待按需解析)`);
  return items;
}

/** 语音能力:在线搜索试听(懒解析) / 下载当前试听版本 */
const dlActions: DlActions = {
  searchList: voiceSearchList,
  // 按需解析单条试听直链:带 6s 超时,失败抛错由引擎顺延下一首
  resolvePreview: async (it) => {
    console.log(`[voice search] 按需解析 ${it.source}:${it.id} ${it.title ?? ""}`);
    const rv = await withTimeout(
      plugins.resolveLowest(it.source, it.id, { title: it.title, artist: it.artist, album: it.album }),
      6000,
    );
    if (!rv?.fileUrl) throw new Error("解析结果为空");
    return rv.fileUrl;
  },
  download: async (item) => {
    const dir = getDefaultDir();
    if (!dir || !dirsContain(dir)) throw new Error("未设置下载目录");
    const url = item.url || (await plugins.resolveLowest(item.source, item.id, { title: item.title, artist: item.artist })).fileUrl;
    startDownload(
      { source: item.source, id: item.id, url, dir, meta: { title: item.title, artist: item.artist } },
      plugins, indexer, dirsContain, db,
    );
    return `已开始下载:${item.title || item.id}`;
  },
};

// 音箱实例:sqlite 优先,首次从 config 播种
if (db.listSpeakers().length === 0 && cfg.speakers.length) {
  for (const sp of cfg.speakers) {
    db.addSpeaker({
      id: sp.id,
      name: sp.name,
      ws_port: sp.wsPort,
      commands: "{}",
      hidden: 0,
      token: "",
      last_ip: "",
      created_at: Date.now(),
    });
  }
  console.log("已从 config 播种音箱实例");
}

const fileUrl = (path: string) =>
  // encodeURIComponent 不转义 ' ! ( ) * —— 撇号会打断音箱端 shell 单引号(见 link.playUrl),这里先 %27 兜底
  `http://${cfg.lanHost}:${cfg.httpPort}/music${path.split("/").map((s) => encodeURIComponent(s).replace(/'/g, "%27")).join("/")}`;

const registry = new SpeakerRegistry({
  db,
  indexer,
  playerCfg: cfg.player,
  getCommands,
  getSearchSem,
  maxResults: cfg.search.maxResults,
  fileUrl,
  dl: dlActions,
});

for (const row of db.listSpeakers()) {
  registry.bind(row);
}

void indexer.refresh()
  .then((n) => console.log(`曲库索引完成: ${n} 首`))
  .catch((e) => console.error("索引失败:", e));

createHttpServer({ cfg, db, indexer, registry, plugins, getDirs, getDefaultDir, getCommands, getSearchSem, getExtensions, webDist: "web/dist" });
console.log(`HTTP 监听 :${cfg.httpPort}(API + 音乐文件 + SPA)`);
