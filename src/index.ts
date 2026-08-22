// miNext 入口 v2:sqlite 驱动的实例注册表 + 曲库 + HTTP
import { loadConfig, type CommandsConfig } from "./config";
import { LibraryDb } from "./library/db";
import { Indexer } from "./library/indexer";
import type { SearchSemantics } from "./library/search";
import { SpeakerRegistry } from "./registry";
import { PluginRegistry } from "./plugins/registry";
import { createHttpServer } from "./http/server";

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
  `http://${cfg.lanHost}:${cfg.httpPort}/music${path.split("/").map(encodeURIComponent).join("/")}`;

const registry = new SpeakerRegistry({
  db,
  indexer,
  playerCfg: cfg.player,
  getCommands,
  getSearchSem,
  maxResults: cfg.search.maxResults,
  fileUrl,
});

for (const row of db.listSpeakers()) {
  registry.bind(row);
}

void indexer.refresh()
  .then((n) => console.log(`曲库索引完成: ${n} 首`))
  .catch((e) => console.error("索引失败:", e));

const plugins = new PluginRegistry(db);

createHttpServer({ cfg, db, indexer, registry, plugins, getDirs, getDefaultDir, getCommands, getSearchSem, getExtensions, webDist: "web/dist" });
console.log(`HTTP 监听 :${cfg.httpPort}(API + 音乐文件 + SPA)`);
