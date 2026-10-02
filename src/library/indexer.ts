// ffprobe 索引器:扫描目录 → 读元数据 → upsert sqlite
import { readdir, stat } from "node:fs/promises";
import { basename, extname, dirname } from "node:path";
import type { LibraryDb } from "./db";
import { emitStats, emitInvalidate } from "../sync";

interface FfprobeOut {
  format?: {
    duration?: string;
    tags?: Record<string, string>;
  };
}

async function probe(filePath: string): Promise<{
  duration: number;
  tags: Record<string, string>;
} | null> {
  try {
    const proc = Bun.spawn(
      [
        "ffprobe", "-v", "error",
        "-show_entries", "format=duration:format_tags",
        "-of", "json", filePath,
      ],
      { stdout: "pipe", stderr: "ignore" },
    );
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) return null;
    const out = JSON.parse(text) as FfprobeOut;
    const duration = parseFloat(out.format?.duration ?? "");
    if (!Number.isFinite(duration) || duration <= 0) return null;
    // tag 键大小写不统一,统一小写
    const tags: Record<string, string> = {};
    for (const [k, v] of Object.entries(out.format?.tags ?? {})) {
      tags[k.toLowerCase()] = String(v);
    }
    return { duration, tags };
  } catch {
    return null;
  }
}

/** 从文件名兜底解析:"标题 - 艺术家.ext" */
function parseFilename(filename: string): { title: string; artist: string } {
  const stem = filename.replace(/\.[^.]+$/, "");
  const parts = stem.split(" - ");
  if (parts.length >= 2) {
    return { title: parts.slice(0, -1).join(" - ").trim(), artist: parts[parts.length - 1].trim() };
  }
  return { title: stem.trim(), artist: "" };
}

async function* walk(dirs: string[], exts: Set<string>): AsyncGenerator<string> {
  for (const dir of dirs) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        yield* walk([full], exts);
      } else if (e.isFile() && exts.has(extname(e.name).toLowerCase())) {
        yield full;
      }
    }
  }
}

/** 文件创建时间(ns):statx birthtime,不支持/为 0 回退 mtime */
function ctimeNsOf(st: { birthtimeMs: number; mtimeMs: number }): number {
  return Math.floor((st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs) * 1e6);
}

export class Indexer {
  private refreshing = false;

  constructor(
    private db: LibraryDb,
    private getDirs: () => string[],
    private extensions: string[],
  ) {}

  setExtensions(exts: string[]) {
    this.extensions = exts;
  }

  get isRefreshing() {
    return this.refreshing;
  }

  /** 全量刷新:新增/mtime 变化的重新 probe,消失的删除。返回曲库总数。 */
  async refresh(onProgress?: (done: number, total: number) => void): Promise<number> {
    if (this.refreshing) throw new Error("索引刷新进行中");
    this.refreshing = true;
    emitStats({ total: this.db.count(), refreshing: true });
    try {
      const exts = new Set(this.extensions.map((e) => e.toLowerCase()));
      const existing = this.db.allPathsMtime();
      const seen: string[] = [];
      const toProbe: { path: string; mtimeNs: number; ctimeNs: number; size: number }[] = [];
      const dirs = this.getDirs();

      for await (const path of walk(dirs, exts)) {
        try {
          const st = await stat(path);
          const mtimeNs = Math.floor(st.mtimeMs * 1e6);
          seen.push(path);
          if (existing.get(path) !== mtimeNs) {
            toProbe.push({ path, mtimeNs, ctimeNs: ctimeNsOf(st), size: st.size });
          }
        } catch {
          /* 读取失败跳过 */
        }
      }

      let done = 0;
      const CONCURRENCY = 4;
      for (let i = 0; i < toProbe.length; i += CONCURRENCY) {
        await Promise.all(
          toProbe.slice(i, i + CONCURRENCY).map(async ({ path, mtimeNs, ctimeNs, size }) => {
            const info = await probe(path);
            if (info) {
              const filename = basename(path);
              const fallback = parseFilename(filename);
              this.db.upsertSong({
                path,
                title: info.tags.title || fallback.title,
                artist: info.tags.artist || fallback.artist,
                album: info.tags.album || "",
                filename,
                dir: dirname(path),
                ext: extname(path).toLowerCase(),
                duration_sec: info.duration,
                size,
                mtime_ns: mtimeNs,
                ctime_ns: ctimeNs,
              });
            }
            done++;
            onProgress?.(done, toProbe.length);
          }),
        );
      }

      this.db.removePathsOutside(dirs);
      const pruned = this.db.removePathsNotIn(seen);
      if (pruned > 0) console.log(`索引清理: ${pruned} 个已消失文件`);
      // ctime 回填:老行(ctime_ns=0)仅 stat 补采,不重新 ffprobe
      const missingCtime = this.db.ctimeMissingPaths();
      for (const p of missingCtime) {
        try {
          const st = await stat(p);
          this.db.setCtime(p, ctimeNsOf(st));
        } catch { /* 文件已消失等,跳过 */ }
      }
      if (missingCtime.length) console.log(`ctime 回填: ${missingCtime.length} 首`);
      return this.db.count();
    } finally {
      this.refreshing = false;
      emitStats({ total: this.db.count(), refreshing: false });
      emitInvalidate("library"); // 曲库内容可能已变(新增/清理)
    }
  }
}
