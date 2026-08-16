// 主 HTTP server v2:REST API + 音乐文件(Range) + SPA 静态托管
import type { AppConfig } from "../config";
import type { LibraryDb, SpeakerRow } from "../library/db";
import type { Indexer } from "../library/indexer";
import type { SpeakerRegistry } from "../registry";
import type { PluginRegistry } from "../plugins/registry";
import { listJobs, startDownload } from "../jobs";
import type { LoopMode } from "../player/engine";
import { rename, unlink, mkdir, rmdir } from "node:fs/promises";
import { readdir } from "node:fs/promises";
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
  const { cfg, db, indexer, registry, plugins, getDirs, getDefaultDir, webDist } = deps;

  const inLibrary = (p: string) => getDirs().some((d) => normalize(p).startsWith(normalize(d)));

  async function api(req: Request, url: URL): Promise<Response> {
    const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
    const method = req.method;

    // ===== /api/plugins & /api/dl =====
    if (parts[0] === "plugins") {
      if (parts.length === 1 && method === "GET") {
        return json({
          plugins: plugins.view(),
          shared: { "chksz.apiKey": db.getSetting("shared.chksz.apiKey") ?? "" },
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
      return err("not found", 404);
    }

    if (parts[0] === "dl") {
      if (parts[1] === "search" && method === "GET") {
        const q = url.searchParams.get("q")?.trim();
        if (!q) return err("缺少 q");
        const view = plugins.view();
        const searches: Promise<unknown[]>[] = [];
        for (const p of plugins.searchPlugins()) {
          for (const src of p.sources) {
            const sv = view.find((v) => v.id === p.id)?.sources.find((s) => s.id === src.id);
            if (!sv?.enabled) continue;
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
          plugins, indexer, (d) => getDirs().includes(d),
        );
        return json({ ok: true, job });
      }
      if (parts[1] === "jobs" && method === "GET") {
        return json({ jobs: listJobs() });
      }
      return err("not found", 404);
    }

    // ===== /api/speakers =====
    if (parts[0] === "speakers") {
      if (parts.length === 1) {
        if (method === "GET") {
          return json(await Promise.all(registry.all().map(async (rt) => ({
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
            player: {
              loop: rt.engine.loop,
              current: rt.engine.current,
              queueLength: (await rt.engine.snapshot()).list.length,
            },
          }))));
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
        const terms = q ? q.split(/\s+/).filter(Boolean) : [];
        const limitRaw = url.searchParams.get("limit") ?? "50";
        const limit = limitRaw === "all" ? 0 : Math.min(parseInt(limitRaw) || 50, 100000);
        const offset = parseInt(url.searchParams.get("offset") ?? "0");
        const sort = url.searchParams.get("sort") ?? undefined;
        const order = (url.searchParams.get("order") ?? "asc") as "asc" | "desc";
        return json(db.search({ terms, limit, offset, sort, order }));
      }
      if (parts[1] === "upload" && method === "POST") {
        const form = await req.formData();
        const file = form.get("file");
        const targetDir = normalize(String(form.get("dir") ?? getDefaultDir() ?? getDirs()[0]));
        if (!inLibrary(targetDir)) return err("目标目录不在曲库范围内", 403);
        if (!(file instanceof File)) return err("缺少 file 字段");
        const name = basename(file.name);
        if (!cfg.audioExtensions.includes(extname(name).toLowerCase())) {
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
        await unlink(path);
        db.removeByPath(path);
        return json({ ok: true });
      }
      if (parts[1] === "rename" && method === "POST") {
        const { path, newName } = (await req.json()) as { path?: string; newName?: string };
        if (!path || !newName) return err("缺少 path/newName");
        if (!inLibrary(path)) return err("路径不在曲库范围内", 403);
        const clean = basename(newName);
        const newPath = join(normalize(path).split("/").slice(0, -1).join("/"), clean);
        await rename(path, newPath);
        db.renamePath(path, newPath, clean, newPath.split("/").slice(0, -1).join("/"));
        return json({ ok: true, path: newPath });
      }
      return err("unknown songs action", 404);
    }

    if (parts[0] === "albums" && method === "GET") {
      return json({ albums: db.albums() });
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
        const r = await link.playUrl(u);
        return json({ ok: shellOk(r), stdout: r.stdout });
      }
      if (action === "shell" && method === "POST") {
        const { script } = (await req.json()) as { script?: string };
        if (!script) return err("缺少 script");
        const r = await link.runShell(script, 15_000);
        return json({ ok: r.exit_code === 0, ...r });
      }
      return err("unknown tools action", 404);
    }

    return err("not found", 404);
  }

  return Bun.serve({
    port: cfg.httpPort,
    async fetch(req) {
      const url = new URL(req.url);
      try {
        if (url.pathname.startsWith("/api/")) return await api(req, url);

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
