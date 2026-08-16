// miNext 入口 v2:sqlite 驱动的实例注册表 + 曲库 + HTTP
import { loadConfig } from "./config";
import { LibraryDb } from "./library/db";
import { Indexer } from "./library/indexer";
import { SpeakerRegistry } from "./registry";
import { createHttpServer } from "./http/server";

const cfg = await loadConfig(process.env.MINEXT_CONFIG ?? "minext.config.json");

const db = new LibraryDb(cfg.dbPath);

// 曲库目录:settings 优先,首次从 config 播种
if (!db.getSettingJSON<string[]>("musicDirs")) db.setSettingJSON("musicDirs", cfg.musicDirs);
if (!db.getSetting("defaultDir")) db.setSetting("defaultDir", cfg.musicDirs[0] ?? "");
const getDirs = () => db.getSettingJSON<string[]>("musicDirs") ?? cfg.musicDirs;
const getDefaultDir = () => db.getSetting("defaultDir") ?? getDirs()[0] ?? "";

const indexer = new Indexer(db, getDirs, cfg.audioExtensions);

// 音箱实例:sqlite 优先,首次从 config 播种
if (db.listSpeakers().length === 0 && cfg.speakers.length) {
  for (const sp of cfg.speakers) {
    db.addSpeaker({
      id: sp.id,
      name: sp.name,
      ws_port: sp.wsPort,
      commands: "{}",
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
  defaultCommands: cfg.commands,
  searchSem: { ...cfg.search },
  maxResults: cfg.search.maxResults,
  fileUrl,
});

for (const row of db.listSpeakers()) {
  registry.bind(row);
}

void indexer.refresh()
  .then((n) => console.log(`曲库索引完成: ${n} 首`))
  .catch((e) => console.error("索引失败:", e));

createHttpServer({ cfg, db, indexer, registry, getDirs, getDefaultDir, webDist: "web/dist" });
console.log(`HTTP 监听 :${cfg.httpPort}(API + 音乐文件 + SPA)`);
