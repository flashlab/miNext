// 下载任务表(内存)+ 执行器:解析 → 拉取 → 落盘 → lrc sidecar → ffprobe 索引
import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { PluginRegistry } from "./plugins/registry";
import type { Indexer } from "./library/indexer";

export interface DownloadJob {
  id: number;
  label: string; // 展示名
  dir: string;
  status: "running" | "done" | "failed";
  error?: string;
  savedPath?: string;
  createdAt: number;
  finishedAt?: number;
}

let nextId = 1;
const jobs: DownloadJob[] = [];

export function listJobs(): DownloadJob[] {
  return [...jobs].sort((a, b) => b.id - a.id).slice(0, 50);
}

function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim() || "untitled";
}

function uniquePath(dir: string, base: string, ext: string): string {
  let p = path.join(dir, `${base}.${ext}`);
  let i = 2;
  while (existsSync(p)) {
    p = path.join(dir, `${base} (${i}).${ext}`);
    i++;
  }
  return p;
}

export interface DownloadRequest {
  source: string;      // wy/tx/kg/url
  id?: string;
  url?: string;
  quality?: string;
  dir: string;
  // 搜索页带来的元数据(下载插件 resolve 不一定回带)
  meta?: { title?: string; artist?: string; album?: string };
}

export function startDownload(
  req: DownloadRequest,
  registry: PluginRegistry,
  indexer: Indexer,
  dirsContain: (dir: string) => boolean,
): DownloadJob {
  const label = req.meta?.artist
    ? `${req.meta.artist} - ${req.meta.title ?? req.id ?? req.url}`
    : (req.meta?.title || req.url || req.id || "下载");
  const job: DownloadJob = { id: nextId++, label, dir: req.dir, status: "running", createdAt: Date.now() };
  jobs.push(job);
  void (async () => {
    try {
      if (!dirsContain(req.dir)) throw new Error("目标目录不在曲库路径内(含子目录)");
      const plugin = registry.downloadPluginFor(req.source);
      if (!plugin) throw new Error(`没有已启用的下载插件支持音源 ${req.source}`);
      const resolved = await plugin.resolve({ source: req.source, id: req.id, url: req.url, quality: req.quality }, registry.ctx);

      const r = await fetch(resolved.fileUrl, { signal: AbortSignal.timeout(120_000) });
      if (!r.ok) throw new Error(`拉取文件失败: HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());

      const title = sanitize(req.meta?.title || resolved.title || "未命名");
      const artist = sanitize(req.meta?.artist || resolved.artist || "");
      const base = artist ? `${artist} - ${title}` : title;
      const savePath = uniquePath(req.dir, base, resolved.ext);
      await writeFile(savePath, buf);

      if (resolved.lrc) {
        await writeFile(savePath.replace(/\.[^.]+$/, ".lrc"), resolved.lrc, "utf8").catch(() => {});
      }
      indexer.refresh().catch(() => {}); // 全量刷新(mtime 增量,秒级)
      job.status = "done";
      job.savedPath = savePath;
    } catch (e) {
      job.status = "failed";
      job.error = String((e as Error).message || e);
    } finally {
      job.finishedAt = Date.now();
    }
  })();
  return job;
}
