// 主 HTTP server v2:REST API + 音乐文件(Range) + SPA 静态托管
import type { AppConfig, CommandsConfig } from "../config";
import type { LibraryDb, SpeakerRow } from "../library/db";
import type { Indexer } from "../library/indexer";
import type { SearchSemantics } from "../library/search";
import type { SpeakerRegistry } from "../registry";
import type { PluginRegistry } from "../plugins/registry";
import { deleteOverrideSource, writeOverrideSource } from "../plugins/lxhost";
import { listJobs, clearJobs, startDownload } from "../jobs";
import type { LoopMode } from "../player/engine";
import { rename, unlink, mkdir, rmdir } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, extname, join, normalize } from "node:path";

const MIME: Record<string, string> = {
  ".mp3": "audio/mpeg", ".flac": "audio/flac", ".wav": "audio/wav",
  ".m4a": "audio/mp4", ".aac": "audio/aac", ".ogg": "audio/ogg",
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".woff2": "font/woff2",
};

export interface HttpDeps {
  cfg: AppConfig;
  db: LibraryDb;
  indexer: Indexer;
  registry: SpeakerRegistry;
  plugins: PluginRegistry;
  getDirs: () => string[];
  getDefaultDir: () => string;
  getCommands: () => CommandsConfig;
  getSearchSem: () => SearchSemantics;
  getExtensions: () => string[];
  webDist: string;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function err(msg: string, status = 400): Response {
  return json({ error: msg }, status);
}

function shellOk(r: { stdout: string; exit_code: number }): boolean {
  return /"code"\s*:\s*0/.test(r.stdout) || r.exit_code === 0;
}

async function serveFile(path: string, req: Request): Promise<Response> {
  const file = Bun.file(path);
  if (!(await file.exists())) return err("not found", 404);
  const size = file.size;
  const type = MIME[extname(path).toLowerCase()] ?? "application/octet-stream";

  const range = req.headers.get("range");
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      const start = m[1] ? parseInt(m[1]) : Math.max(0, size - parseInt(m[2] || "0"));
      const end = m[1] && m[2] ? Math.min(parseInt(m[2]), size - 1) : size - 1;
      if (start >= size || start > end) {
        return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
      }
      return new Response(file.slice(start, end + 1), {
        status: 206,
        headers: {
          "content-type": type,
          "content-range": `bytes ${start}-${end}/${size}`,
          "accept-ranges": "bytes",
          "content-length": String(end - start + 1),
        },
      });
    }
  }
  return new Response(file, {
    headers: { "content-type": type, "accept-ranges": "bytes", "content-length": String(size) },
  });
}

export function createHttpServer(deps: HttpDeps) {
  const { cfg, db, indexer, registry, plugins, getDirs, getDefaultDir, getCommands, getSearchSem, getExtensions, webDist } = deps;

  const inLibrary = (p: string) => getDirs().some((d) => {
    const np = normalize(p);
    const nd = normalize(d).replace(/\/+$/, "");
    return np === nd || np.startsWith(nd + "/");
  });

  /** 客户端地址(多标签页/多设备排查用) */
  function clientIp(server: unknown, req: Request): string {
    try {
      const r = (server as { requestIP?: (req: Request) => { address?: string } | null }).requestIP?.(req);
      return r?.address ?? "?";
    } catch { return "?"; }
  }

  async function api(req: Request, url: URL, ip: string): Promise<Response> {
    const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
    const method = req.method;

    // ===== /api/plugins & /api/dl =====
    if (parts[0] === "plugins") {
      if (parts.length === 1 && method === "GET") {
        return json({
          plugins: plugins.view(),
          shared: {
            "chksz.apiKey": db.getSetting("shared.chksz.apiKey") ?? "",
            "ynx.apiKey": db.getSetting("shared.ynx.apiKey") ?? "",
            "dl.dir": db.getSetting("shared.dl.dir") ?? "",
            "dl.preview": db.getSetting("shared.dl.preview") ?? "",
          },
        });
      }
      if (parts[1] === "shared" && method === "PUT") {
        const body = (await req.json()) as { key?: string; value?: string };
        if (!body.key || !/^[a-z0-9._-]+$/i.test(body.key)) return err("非法 key");
        plugins.saveShared(body.key, body.value ?? "");
        return json({ ok: true });
      }
      if (parts[1] && parts[2] === "settings" && method === "PUT") {
        const body = (await req.json()) as Record<string, unknown>;
        const r = plugins.saveSettings(parts[1], body);
        if (!r.ok) return err(r.error, 409);
        return json({ ok: true });
      }
      // lx 自定义源:PUT 上传替换(原文 body,≤512KB),DELETE 恢复内置默认;两者都热重载无需重启
      if (parts[1] === "lxdownload" && parts[2] === "source" && method === "PUT") {
        const code = await req.text();
        if (!code.trim()) return err("空文件");
        if (code.length > 512 * 1024) return err("文件过大(上限 512KB)");
        writeOverrideSource(code);
        const info = await plugins.reloadLxSource();
        return json({ ok: !info.loadFailed, ...info });
      }
      if (parts[1] === "lxdownload" && parts[2] === "source" && method === "DELETE") {
        deleteOverrideSource();
        const info = await plugins.reloadLxSource();
        return json({ ok: true, ...info });
      }
      return err("not found", 404);
    }

    if (parts[0] === "dl") {
      if (parts[1] === "search" && method === "GET") {
        const q = url.searchParams.get("q")?.trim();
        if (!q) return err("缺少 q");
        const view = plugins.view();
        const searches: Promise<unknown[]>[] = [];
        const claimed = new Set<string>(); // 运行时互斥:同平台注册序靠前者赢(保存时 409 拦截,这里兜遗留双开)
        for (const p of plugins.searchPlugins()) {
          for (const src of p.sources) {
            const sv = view.find((v) => v.id === p.id)?.sources.find((s) => s.id === src.id);
            if (!sv?.enabled) continue;
            if (claimed.has(src.id)) { console.log(`[plugins] 音源 ${src.id} 已被排前的搜索插件接管,跳过 ${p.id}`); continue; }
            claimed.add(src.id);
            searches.push(
              p.search(src.id, q, sv.limit ?? 20, plugins.ctx)
                .then((r) => r as unknown[])
                .catch((e: Error) => [{ __error: String(e?.message ?? e), __source: src.id }]),
            );
          }
        }
        const settled = await Promise.all(searches);
        const results: unknown[] = [];
        const errors: { source: string; error: string }[] = [];
        for (const r of settled.flat() as Record<string, unknown>[]) {
          if (r.__error) errors.push({ source: String(r.__source ?? "?"), error: String(r.__error) });
          else results.push(r);
        }
        return json({ results, errors });
      }
      if (parts[1] === "download" && method === "POST") {
        const body = (await req.json()) as {
          source?: string; id?: string; url?: string; quality?: string; dir?: string;
          meta?: { title?: string; artist?: string; album?: string };
        };
        if (!body.dir) return err("缺少目标目录");
        if (!body.url && !body.id) return err("缺少 id 或链接");
        const job = startDownload(
          { source: body.source ?? "url", id: body.id, url: body.url, quality: body.quality, dir: body.dir, meta: body.meta },
          plugins, indexer, (d) => inLibrary(d), db,
        );
        return json({ ok: true, job });
      }
      if (parts[1] === "jobs" && method === "GET") {
        return json({ jobs: listJobs() });
      }
      // 清理已结束的任务(done/failed),running 保留
      if (parts[1] === "jobs" && method === "DELETE") {
        return json({ ok: true, removed: clearJobs() });
      }
      // 试听:以最低音质解析直链(不下载)
      if (parts[1] === "resolve" && method === "POST") {
        const body = (await req.json()) as { source?: string; id?: string; meta?: { title?: string; artist?: string; album?: string } };
        if (!body.source || !body.id) return err("缺少 source/id");
        const plugin = plugins.downloadPluginFor(body.source);
        if (!plugin) return err(`${plugins.sourceDisplayName(body.source ?? "")}未激活下载插件`, 404);
        const lowest = plugin.qualities?.[body.source]?.[0];
        console.log(`[dl] resolve ${body.source} from ${ip}`);
        try {
          const r = await plugin.resolve({ source: body.source, id: body.id, quality: lowest, meta: body.meta }, plugins.ctx);
          return json({ ok: true, fileUrl: r.fileUrl });
        } catch (e) {
          return err(String((e as Error).message || e), 502);
        }
      }
      return err("not found", 404);
    }

    // ===== /api/speakers =====
    if (parts[0] === "speakers") {
      if (parts.length === 1) {
        if (method === "GET") {
          return json(await Promise.all(registry.all().map(async (rt) => {
            // 麦克风真实状态:在线时读音箱 /tmp/mipns/mute(3s 轮询一次,与物理静音键同步)
            let micMuted: boolean | null = null;
            if (rt.link.online) {
              try { micMuted = (await rt.link.getMicStatus()) === "off"; } catch { micMuted = null; }
            }
            return {
              id: rt.row.id,
              name: rt.row.name,
              wsPort: rt.row.ws_port,
              commands: JSON.parse(rt.row.commands || "{}"),
              hidden: Boolean(rt.row.hidden),
              token: rt.row.token,
              lastIp: rt.link.lastIp || rt.row.last_ip || "",
              online: rt.link.online,
              lastEventAt: rt.link.lastEventAt || null,
              playing: rt.link.playing,
              device: rt.link.deviceInfo,
              micMuted,
              nativeVoiceDisabledUntil: rt.engine.nativeVoiceDisabled ? rt.engine.nativeVoiceDisabledUntil : null,
              player: {
                loop: rt.engine.loop,
                current: rt.engine.current,
                queueLength: (await rt.engine.snapshot()).list.length,
              },
            };
          })));
        }
        if (method === "POST") {
          const body = (await req.json()) as { wsPort?: number; name?: string; commands?: Record<string, string[]>; token?: string };
          if (!body.wsPort || body.wsPort < 1024 || body.wsPort > 65535) return err("非法端口");
          if (db.listSpeakers().some((s) => s.ws_port === body.wsPort)) return err("端口已被占用", 409);
          const row: SpeakerRow = {
            id: `s${body.wsPort}`,
            name: body.name?.trim() || `音箱-${body.wsPort}`,
            ws_port: body.wsPort,
            commands: JSON.stringify(body.commands ?? {}),
            hidden: 0,
            token: body.token?.trim() ?? "",
            last_ip: "",
            created_at: Date.now(),
          };
          db.addSpeaker(row);
          registry.bind(row);
          return json({ ok: true, speaker: row });
        }
      }
      const id = parts[1];
      const action = parts[2];
      const rt = registry.get(id);
      if (!rt) return err(`未知音箱: ${id}`, 404);

      if (!action && method === "PUT") {
        const body = (await req.json()) as { name?: string; wsPort?: number; commands?: Record<string, string[]>; hidden?: boolean; token?: string };
        if (body.wsPort !== undefined && (body.wsPort < 1024 || body.wsPort > 65535)) return err("非法端口");
        if (body.wsPort !== undefined && body.wsPort !== rt.row.ws_port &&
            db.listSpeakers().some((s) => s.ws_port === body.wsPort)) return err("端口已被占用", 409);
        const patch: { name?: string; ws_port?: number; commands?: string; hidden?: number; token?: string } = {};
        if (body.name !== undefined) patch.name = body.name.trim() || rt.row.name;
        if (body.wsPort !== undefined) patch.ws_port = body.wsPort;
        if (body.commands !== undefined) patch.commands = JSON.stringify(body.commands);
        if (body.hidden !== undefined) patch.hidden = body.hidden ? 1 : 0;
        if (body.token !== undefined) patch.token = body.token.trim();
        db.updateSpeaker(id, patch);
        const row = db.listSpeakers().find((s) => s.id === id)!;
        registry.reconfigure(row);
        return json({ ok: true, speaker: row });
      }
      if (!action && method === "DELETE") {
        const wasOnline = rt.link.online;
        registry.remove(id);
        return json({ ok: true, note: wasOnline ? "实例已删除,音箱将持续重试连接直至重新添加" : "实例已删除" });
      }
      if (action === "reconnect" && method === "POST") {
        rt.link.reconnect();
        return json({ ok: true, note: "连接已断开,音箱将在 1s 后自动重连" });
      }
      return err("unknown speakers action", 404);
    }

    // ===== /api/library =====
    if (parts[0] === "library") {
      // 目录树:?path=<abs> → 直接子目录(仅曲库范围内)
      if (parts[1] === "tree" && method === "GET") {
        const p = url.searchParams.get("path") ?? "";
        if (!p || !inLibrary(normalize(p))) return err("路径不在曲库范围内", 403);
        try {
          const entries = await readdir(p, { withFileTypes: true });
          const dirs = entries
            .filter((e) => e.isDirectory() && !e.name.startsWith("."))
            .map((e) => e.name)
            .sort();
          return json({ path: p, dirs });
        } catch {
          return err("目录不可读", 400);
        }
      }
      if (parts[1] === "refresh" && method === "POST") {
        if (indexer.isRefreshing) return err("索引刷新进行中", 409);
        void indexer.refresh().then(
          (n) => console.log(`索引刷新完成: ${n} 首`),
          (e) => console.error("索引刷新失败:", e),
        );
        return json({ ok: true, note: "刷新已开始" });
      }
      if (parts[1] === "stats" && method === "GET") {
        return json({ total: db.count(), refreshing: indexer.isRefreshing });
      }
      if (parts[1] === "dirs") {
        if (parts[2] === "default" && method === "PUT") {
          const { dir } = (await req.json()) as { dir?: string };
          if (!dir || !getDirs().includes(dir)) return err("目录不在曲库列表中");
          db.setSetting("defaultDir", dir);
          return json({ ok: true });
        }
        if (method === "GET") return json({ dirs: getDirs(), defaultDir: getDefaultDir() });
        if (method === "POST") {
          const { dir } = (await req.json()) as { dir?: string };
          if (!dir) return err("缺少 dir");
          const nd = normalize(dir).replace(/\/+$/, "");
          if (!nd.startsWith("/")) return err("需要绝对路径");
          if (getDirs().includes(nd)) return err("目录已存在", 409);
          await mkdir(nd, { recursive: true });
          const dirs = [...getDirs(), nd];
          db.setSettingJSON("musicDirs", dirs);
          void indexer.refresh().catch(() => {});
          return json({ ok: true, dirs, defaultDir: getDefaultDir() });
        }
        if (method === "DELETE") {
          const { dir, deleteFiles } = (await req.json()) as { dir?: string; deleteFiles?: boolean };
          if (!dir) return err("缺少 dir");
          const dirs = getDirs().filter((d) => d !== dir);
          db.setSettingJSON("musicDirs", dirs);
          if (getDefaultDir() === dir) db.setSetting("defaultDir", dirs[0] ?? "");
          if (deleteFiles) {
            // 仅当目录变空才物理删除,且目录必须仍在白名单历史里(它刚被移出,用原值校验)
            try {
              const files = await readdir(dir);
              if (files.length === 0) await rmdir(dir);
            } catch { /* 目录不存在等,忽略 */ }
          }
          void indexer.refresh().catch(() => {});
          return json({ ok: true, dirs, defaultDir: getDefaultDir() });
        }
      }
      return err("unknown library action", 404);
    }

    // ===== /api/songs =====
    if (parts[0] === "songs") {
      if (parts.length === 1 && method === "GET") {
        const q = (url.searchParams.get("q") ?? "").trim();
        const limitRaw = url.searchParams.get("limit") ?? "50";
        const limit = limitRaw === "all" ? 0 : Math.min(parseInt(limitRaw) || 50, 100000);
        const offset = parseInt(url.searchParams.get("offset") ?? "0");
        const sort = url.searchParams.get("sort") ?? undefined;
        const order = (url.searchParams.get("order") ?? "asc") as "asc" | "desc";
        return json(db.search({ q, limit, offset, sort, order }));
      }
      if (parts[1] === "upload" && method === "POST") {
        const form = await req.formData();
        const file = form.get("file");
        const targetDir = normalize(String(form.get("dir") ?? getDefaultDir() ?? getDirs()[0]));
        if (!inLibrary(targetDir)) return err("目标目录不在曲库范围内", 403);
        if (!(file instanceof File)) return err("缺少 file 字段");
        const name = basename(file.name);
        if (!getExtensions().includes(extname(name).toLowerCase())) {
          return err(`不支持的格式: ${extname(name)}`);
        }
        await mkdir(targetDir, { recursive: true });
        const dest = join(targetDir, name);
        await Bun.write(dest, file);
        void indexer.refresh().catch(() => {});
        return json({ ok: true, path: dest });
      }
      if (parts[1] === "delete" && method === "POST") {
        const { path } = (await req.json()) as { path?: string };
        if (!path) return err("缺少 path");
        if (!inLibrary(path)) return err("路径不在曲库范围内", 403);
        // 回收站语义:仅标记删除,文件保留;物理删走 /api/trash/purge
        const row = db.markDeleted(path);
        if (!row) return err("曲目不存在", 404);
        return json({ ok: true, note: "已标记删除,可在回收站恢复" });
      }
      if (parts[1] === "rename" && method === "POST") {
        // 批量改名/移动:以默认曲库目录为基准,模式串按最后一个 "/" 切分为 子目录/文件名前缀
        //   "new/" → 移到 defaultDir/new/;"new/abc-" → 移动且加前缀;"abc-" → 仅加前缀
        const { paths, pattern } = (await req.json()) as { paths?: string[]; pattern?: string };
        if (!Array.isArray(paths) || !paths.length) return err("缺少 paths");
        if (typeof pattern !== "string") return err("缺少 pattern");
        const def = normalize(getDefaultDir()).replace(/\/+$/, "");
        if (!def) return err("未设置默认曲库目录");

        const s = pattern.trim().replace(/^\/+/, "");
        if (!s) return err("模式为空或无操作");
        let dirPart = "", prefix = "";
        if (s.endsWith("/")) {
          dirPart = s.replace(/\/+$/, "");
        } else {
          const i = s.lastIndexOf("/");
          if (i >= 0) { dirPart = s.slice(0, i); prefix = s.slice(i + 1); }
          else prefix = s;
        }
        if (!dirPart && !prefix) return err("无操作");
        if (prefix === "." || prefix === "..") return err("非法前缀");
        const targetDir = dirPart ? normalize(join(def, dirPart)) : def;
        if (targetDir !== def && !targetDir.startsWith(def + "/")) return err("目标目录越出默认曲库", 403);

        const rows = db.getByPaths(paths); // 仅正常曲目(回收站条目不可改名)
        if (!rows.length) return err("没有匹配的曲目", 404);
        await mkdir(targetDir, { recursive: true });
        let moved = 0, skipped = 0, failed = 0;
        const failures: string[] = [];
        for (const row of rows) {
          const src = normalize(row.path);
          if (!inLibrary(src)) { failed++; failures.push(`${row.filename}: 不在曲库范围内`); continue; }
          const ext = extname(row.filename);
          const stem = ext ? row.filename.slice(0, -ext.length) : row.filename;
          const newName = prefix + stem + ext;
          const dest = join(targetDir, newName);
          if (dest === src || existsSync(dest)) { skipped++; continue; }
          try {
            await rename(src, dest);
            // .lrc 歌词副文件跟随(与回收站 purge 口径一致)
            try { await rename(src.replace(/\.[^.]+$/, ".lrc"), dest.replace(/\.[^.]+$/, ".lrc")); } catch { /* 无 sidecar */ }
            db.renamePath(src, dest, newName, targetDir);
            moved++;
          } catch (e) {
            failed++;
            failures.push(`${row.filename}: ${(e as Error).message}`);
          }
        }
        return json({ ok: true, moved, skipped, failed, failures: failures.slice(0, 5) });
      }
      return err("unknown songs action", 404);
    }

    // ===== /api/trash(回收站) =====
    if (parts[0] === "trash") {
      if (parts.length === 1 && method === "GET") {
        return json({ count: db.trashCount(), songs: db.trashList() });
      }
      if (parts[1] === "restore" && method === "POST") {
        const { paths } = (await req.json()) as { paths?: string[] };
        if (!paths?.length) return err("缺少 paths");
        return json({ ok: true, restored: db.restore(paths) });
      }
      if (parts[1] === "purge" && method === "POST") {
        const { paths } = (await req.json().catch(() => ({}))) as { paths?: string[] };
        const rows = db.purgeTrashed(paths?.length ? paths : undefined);
        // 物理删文件(含 .lrc sidecar),失败仅记日志
        for (const r of rows) {
          for (const p of [r.path, r.path.replace(/\.[^.]+$/, ".lrc")]) {
            try { await unlink(p); } catch { /* 文件不存在等,忽略 */ }
          }
        }
        return json({ ok: true, purged: rows.length });
      }
      return err("unknown trash action", 404);
    }

    if (parts[0] === "albums" && method === "GET") {
      return json({ albums: db.albums() });
    }

    // ===== /api/settings/global(全局设置:关键词/后缀/搜索语义) =====
    if (parts[0] === "settings" && parts[1] === "global") {
      if (method === "GET") {
        return json({ commands: getCommands(), audioExtensions: getExtensions(), search: getSearchSem() });
      }
      if (method === "PUT") {
        const body = (await req.json()) as {
          commands?: Partial<CommandsConfig>;
          audioExtensions?: string[];
          search?: Partial<SearchSemantics>;
        };
        const ALLOWED_EXT = [".mp3", ".aac", ".ogg", ".m4a", ".flac", ".ape", ".wav"];
        if (body.commands !== undefined) {
          const cmds: Record<string, string[]> = {};
          for (const [k, v] of Object.entries(body.commands)) {
            if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x.trim())) return err(`关键词组 ${k} 非法`);
            cmds[k] = v.map((x) => x.trim());
          }
          db.setSettingJSON("globalCommands", { ...getCommands(), ...cmds });
          registry.applyCommands(getCommands());
        }
        if (body.audioExtensions !== undefined) {
          const norm = body.audioExtensions.map((e) => (e.startsWith(".") ? e.toLowerCase() : `.${e.toLowerCase()}`));
          if (!norm.length || norm.some((e) => !ALLOWED_EXT.includes(e))) return err(`后缀须为: ${ALLOWED_EXT.join(" ")}`);
          const changed = JSON.stringify(norm) !== JSON.stringify(getExtensions());
          db.setSettingJSON("audioExtensions", norm);
          if (changed) {
            indexer.setExtensions(norm);
            void indexer.refresh().catch(() => {}); // 新纳入格式需重建入库
          }
        }
        if (body.search !== undefined) {
          const s = body.search;
          if (s.maxResults !== undefined && (!Number.isInteger(s.maxResults) || s.maxResults < 1 || s.maxResults > 500)) return err("maxResults 须为 1-500 整数");
          for (const k of ["artistSeparators", "albumSeparators"] as const) {
            if (s[k] !== undefined && (!Array.isArray(s[k]) || !s[k]!.every((x) => typeof x === "string" && x.trim()))) return err(`${k} 非法`);
          }
          db.setSettingJSON("searchSem", { ...getSearchSem(), ...s });
          registry.applySearchSem(getSearchSem());
        }
        return json({ ok: true, commands: getCommands(), audioExtensions: getExtensions(), search: getSearchSem() });
      }
      return err("method?", 405);
    }

    // ===== /api/player/:id/:action =====
    if (parts[0] === "player") {
      const id = parts[1];
      const action = parts[2];
      const rt = registry.get(id);
      if (!rt) return err(`未知音箱: ${id}`, 404);
      const { engine, voice } = rt;

      if (action === "state" && method === "GET") return json(await engine.snapshot());
      if (action === "loop" && method === "POST") {
        const { mode } = (await req.json()) as { mode?: LoopMode };
        if (!mode || !["off", "one", "all", "random"].includes(mode)) return err("非法循环模式");
        engine.loop = mode;
        return json({ ok: true, loop: engine.loop });
      }
      if (action === "stop-after-current" && method === "POST") {
        const { on } = (await req.json()) as { on?: boolean };
        engine.stopAfterCurrent = Boolean(on);
        return json({ ok: true, stopAfterCurrent: engine.stopAfterCurrent });
      }
      if (action === "volume" && method === "POST") {
        const { volume } = (await req.json()) as { volume?: number };
        if (volume === undefined) return err("缺少 volume");
        await engine.setVolume(volume);
        return json({ ok: true });
      }
      if (action === "play" && method === "POST") {
        const body = (await req.json()) as { paths?: string[]; keyword?: string };
        if (body.keyword) { void voice.playByKeyword(body.keyword); return json({ ok: true }); }
        if (body.paths?.length) {
          const songs = db.getByPaths(body.paths);
          if (!songs.length) return err("没有匹配的歌曲");
          void engine.playQueue(songs);
          return json({ ok: true, count: songs.length });
        }
        return err("需要 paths 或 keyword");
      }
      if (action === "append" && method === "POST") {
        const { paths } = (await req.json()) as { paths?: string[] };
        if (!paths?.length) return err("缺少 paths");
        const songs = db.getByPaths(paths);
        void engine.appendQueue(songs);
        return json({ ok: true, count: songs.length });
      }
      if (action === "list" && method === "POST") {
        const body = (await req.json()) as { op?: string; index?: number; from?: number; to?: number };
        if (!body.op) return err("缺少 op");
        await engine.listOp(body.op as "playNow" | "pinTop" | "playNext" | "remove" | "reorder", body);
        return json({ ok: true });
      }
      if (action === "toggle" && method === "POST") return json({ ok: true, result: await engine.toggle() });
      // 停止(保留列表):试听落音箱前用它压掉队列播放与自动续播定时器
      if (action === "stop" && method === "POST") { await engine.stop(`web from ${ip}`); return json({ ok: true }); }
      if (action === "random" && method === "POST") { void voice.playRandom(); return json({ ok: true }); }
      if (action === "next" && method === "POST") { void engine.next(); return json({ ok: true }); }
      if (action === "prev" && method === "POST") { void engine.prev(); return json({ ok: true }); }
      return err("unknown player action", 404);
    }

    // ===== /api/tools/:id/:action =====
    if (parts[0] === "tools") {
      const id = parts[1];
      const action = parts[2];
      const rt = registry.get(id);
      if (!rt) return err(`未知音箱: ${id}`, 404);
      const { link } = rt;

      if (action === "say" && method === "POST") {
        const { text } = (await req.json()) as { text?: string };
        if (!text) return err("缺少 text");
        const r = await link.speakText(text);
        return json({ ok: shellOk(r), stdout: r.stdout });
      }
      if (action === "ask" && method === "POST") {
        const { text } = (await req.json()) as { text?: string };
        if (!text) return err("缺少 text");
        const r = await link.askXiaoAi(text);
        return json({ ok: shellOk(r), stdout: r.stdout });
      }
      if (action === "play-url" && method === "POST") {
        const { url: u } = (await req.json()) as { url?: string };
        if (!u) return err("缺少 url");
        console.log(`[${id}] play-url from ${ip}`);
        const r = await link.playUrl(u);
        return json({ ok: shellOk(r), stdout: r.stdout });
      }
      if (action === "shell" && method === "POST") {
        const { script } = (await req.json()) as { script?: string };
        if (!script) return err("缺少 script");
        const r = await link.runShell(script, 15_000);
        return json({ ok: r.exit_code === 0, ...r });
      }
      // 暂停(试听停止用,直接 mphelper pause,不动播放列表)
      if (action === "pause" && method === "POST") {
        console.log(`[${id}] pause(试听停止) from ${ip}`);
        const r = await link.pausePlayback();
        return json({ ok: shellOk(r), stdout: r.stdout });
      }
      // 禁用原生语音:on=true → 拦截窗口延长到 5 分钟;on=false → 立即解除(与 20s 临时武装窗口相互独立)
      if (action === "native-voice" && method === "POST") {
        const { on } = (await req.json()) as { on?: boolean };
        if (typeof on !== "boolean") return err("缺少 on");
        const until = on ? Date.now() + 300_000 : 0;
        rt.engine.setNativeVoiceDisabled(until);
        return json({ ok: true, nativeVoiceDisabledUntil: until || null });
      }
      // 麦克风开关:pnshelper event 8=关 / 7=开,返回执行后的真实状态
      if (action === "mic" && method === "POST") {
        const { muted } = (await req.json()) as { muted?: boolean };
        if (typeof muted !== "boolean") return err("缺少 muted");
        if (!link.online) return err(`音箱 ${id} 不在线`, 502);
        const r = muted ? await link.micOff() : await link.micOn();
        if (!shellOk(r)) return err(r.stdout.slice(0, 200) || "执行失败", 502);
        const status = await link.getMicStatus().catch(() => null);
        return json({ ok: true, micMuted: status === "off" ? true : status === "on" ? false : null });
      }
      return err("unknown tools action", 404);
    }

    return err("not found", 404);
  }

  return Bun.serve({
    port: cfg.httpPort,
    // 默认 idleTimeout 仅 10s:聚合搜索多源并发最坏 ~20s+,曾致请求被静默断连;放宽到 60s
    idleTimeout: 60,
    async fetch(req, server) {
      const url = new URL(req.url);
      const ip = clientIp(server, req);
      try {
        if (url.pathname.startsWith("/api/")) return await api(req, url, ip);

        if (url.pathname.startsWith("/music/")) {
          const decoded = url.pathname.slice("/music".length).split("/").map(decodeURIComponent).join("/");
          if (!inLibrary(decoded)) return err("路径不在曲库范围内", 403);
          return await serveFile(decoded, req);
        }

        let p = join(webDist, url.pathname === "/" ? "index.html" : url.pathname);
        let file = Bun.file(p);
        if (await file.exists()) {
          return new Response(file, {
            headers: { "content-type": MIME[extname(p).toLowerCase()] ?? "application/octet-stream" },
          });
        }
        const index = Bun.file(join(webDist, "index.html"));
        if (await index.exists()) {
          return new Response(index, { headers: { "content-type": "text/html" } });
        }
        return new Response("miNext 后端运行中(前端尚未构建)", { status: 200 });
      } catch (e) {
        console.error("http error:", e);
        return err(String(e), 500);
      }
    },
  });
}
