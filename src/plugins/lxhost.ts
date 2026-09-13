// lx-music 自定义源宿主(下载插件):加载单个 lx 源 JS,把它的 musicUrl 能力接进取链轴
// 加载顺序:data/lx-source.js(自定义覆盖) > 内置默认 src/plugins/lx/ynx-default.js
// 换源:前端插件设置弹窗上传/恢复(PUT|DELETE /api/plugins/lxdownload/source,热重载),或手动替换文件 + 重启
// 隔离 = new Function + 白名单 lx 对象。注意:shadow 标识符只挡直接引用,脚本经 globalThis 仍能拿到真实全局
// ——与官方宿主同级信任模型(手动安装),勿加载来路不明的源;壳源(签名/握手绑定服务端)见仓库 docs 与实测结论
// lx.request 传输层 = curl 子进程(Bun fetch 对部分后端相性差,与枫雨/chksz 插件同策)
import { spawn } from "node:child_process";
import { constants, createCipheriv, createHash, publicEncrypt, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DownloadPlugin, PluginCtx, ResolvedAudio, SourceDef } from "./types";

const QUALITY_ORDER = ["128k", "320k", "flac", "flac24bit"] as const; // 升序:[0] = 最低档(试听语义)
const SOURCE_WHITELIST = new Set(["kw", "kg", "tx", "wy", "mg"]);
const SOURCE_NAMES: Record<string, string> = { kw: "酷我", kg: "酷狗", tx: "QQ音乐", wy: "网易云", mg: "咪咕" };
const OVERRIDE_PATH = path.resolve("data/lx-source.js");
const DEFAULT_PATH = fileURLToPath(new URL("./lx/ynx-default.js", import.meta.url));

/** 写入自定义覆盖源(原子:tmp + rename),随后需 reloadLxSource() 生效 */
export function writeOverrideSource(code: string): void {
  mkdirSync(path.dirname(OVERRIDE_PATH), { recursive: true });
  const tmp = OVERRIDE_PATH + ".tmp";
  writeFileSync(tmp, code);
  renameSync(tmp, OVERRIDE_PATH);
}

/** 删除自定义覆盖源(恢复内置默认);返回是否存在过覆盖文件 */
export function deleteOverrideSource(): boolean {
  if (!existsSync(OVERRIDE_PATH)) return false;
  unlinkSync(OVERRIDE_PATH);
  return true;
}

function extFromUrl(url: string, fallback = "mp3"): string {
  const m = url.match(/\.([a-z0-9]{2,5})(?:\?|$)/i);
  return (m?.[1] ?? fallback).toLowerCase();
}

interface LxResp {
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string>;
  body: string;
}

/** lx.request(url, opts, cb) 的宿主实现:curl 子进程,-i 拆响应头(无 -L,100-continue 循环剥) */
function curlRequest(
  url: string,
  opts: Record<string, unknown> | undefined,
  cb: (err: Error | null, resp?: LxResp, body?: string) => void,
): () => void {
  const timeoutSec = Math.ceil(Math.min(Number(opts?.timeout) || 20000, 60000) / 1000);
  const args = ["-s", "-i", "--compressed", "-m", String(timeoutSec), "-X", String(opts?.method ?? "GET")];
  for (const [k, v] of Object.entries((opts?.headers ?? {}) as Record<string, string>)) args.push("-H", `${k}: ${v}`);
  if (opts?.body != null) args.push("--data-raw", String(opts.body));
  else if (opts?.form != null) args.push("--data", String(opts.form));
  args.push(url);
  const p = spawn("curl", args, { stdio: ["ignore", "pipe", "pipe"] });
  const chunks: Buffer[] = [];
  let errBuf = "";
  let done = false;
  const finish = (err: Error | null, resp?: LxResp) => {
    if (done) return;
    done = true;
    cb(err, resp, resp?.body);
  };
  p.stdout.on("data", (d: Buffer) => chunks.push(d));
  p.stderr.on("data", (d: Buffer) => (errBuf += d));
  p.on("error", (e) => finish(e));
  p.on("close", (code) => {
    if (code !== 0) return finish(new Error(`curl exit ${code}: ${errBuf.slice(0, 120)}`));
    let text = Buffer.concat(chunks).toString("utf8");
    let statusCode = 0;
    let statusMessage = "";
    const headers: Record<string, string> = {};
    for (;;) {
      const idx = text.indexOf("\r\n\r\n");
      if (idx < 0) break; // 头解析失败:整体当 body
      const head = text.slice(0, idx);
      const m = head.match(/^HTTP\/[\d.]+ (\d+)\s*(.*)/);
      if (!m) break;
      statusCode = Number(m[1]);
      statusMessage = m[2] ?? "";
      for (const line of head.split("\r\n").slice(1)) {
        const c = line.indexOf(":");
        if (c > 0) headers[line.slice(0, c).trim().toLowerCase()] = line.slice(c + 1).trim();
      }
      text = text.slice(idx + 4);
      if (statusCode !== 100) break;
    }
    finish(null, { statusCode, statusMessage, headers, body: text });
  });
  return () => p.kill();
}

interface LxInited {
  status?: boolean;
  message?: string;
  sources?: Record<string, { name?: string; qualitys?: unknown }>;
}

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}

export class LxDownloadPlugin implements DownloadPlugin {
  readonly kind = "download" as const;
  readonly id = "lxdownload";
  readonly name = "lx-music 下载";
  readonly defaultEnabledSources = ["kw"]; // 与既有分工一致:chksz 扛 wy/tx/kg,lx 默认源扛 kw
  private declared: Record<string, { name: string; qualitys: string[] }> = {};
  private handler: ((payload: { action: string; source: string; info: unknown }) => unknown) | null = null;
  private scriptName = "";
  private scriptMd5 = "";
  private scriptPath = "";
  private loadError = "";
  private ctx: PluginCtx | null = null;

  /** 声明驱动:源列表随加载的 JS 动态生成(send(inited) 捕获) */
  get sources(): SourceDef[] {
    return Object.entries(this.declared).map(([id, s]) => ({ id, name: s.name || SOURCE_NAMES[id] || id }));
  }
  get qualities(): Record<string, string[]> {
    return Object.fromEntries(Object.entries(this.declared).map(([id, s]) => [id, s.qualitys]));
  }
  runtimeInfo(): Record<string, unknown> {
    return {
      scriptName: this.scriptName || "(未加载)",
      scriptMd5: this.scriptMd5,
      override: this.scriptPath === OVERRIDE_PATH,
      loadFailed: Boolean(this.loadError),
      loadError: this.loadError || undefined,
    };
  }

  async load(ctx: PluginCtx): Promise<void> {
    this.ctx = ctx;
    mkdirSync(path.dirname(OVERRIDE_PATH), { recursive: true });
    this.scriptPath = existsSync(OVERRIDE_PATH) ? OVERRIDE_PATH : DEFAULT_PATH;
    const code = readFileSync(this.scriptPath, "utf8");
    this.scriptMd5 = createHash("md5").update(code).digest("hex");
    this.scriptName = code.match(/@name\s+([^\n*]+)/)?.[1]?.trim() ?? path.basename(this.scriptPath);
    this.declared = {};
    this.handler = null;
    this.loadError = "";

    const initedBox: { v: LxInited | null } = { v: null };
    const lx = this.buildLxApi((data) => {
      if (!initedBox.v) initedBox.v = data as LxInited;
    });
    const g = globalThis as Record<string, unknown>;
    const prevLx = g.lx;
    g.lx = lx;
    try {
      // sloppy 模式(new Function 体 this = 真实 globalThis);标准 lx 源经 globalThis.lx 取 API
      new Function("require", "process", "module", "exports", "Bun", "fetch", "XMLHttpRequest", code)();
    } catch (e) {
      this.loadError = `加载异常: ${String((e as Error).message || e).slice(0, 160)}`;
      console.error("[lx-source] 加载抛错:", e);
    } finally {
      if (prevLx === undefined) delete g.lx;
      else g.lx = prevLx;
    }
    if (!this.loadError && !initedBox.v) await waitFor(() => initedBox.v !== null, 8000);
    const inited = initedBox.v;
    if (!this.loadError) {
      if (!inited) this.loadError = "8s 内未 send(inited)";
      else if (inited.status === false) this.loadError = `inited status=false ${inited.message ?? ""}`.trim();
      else {
        for (const [id, s] of Object.entries(inited.sources ?? {})) {
          if (!SOURCE_WHITELIST.has(id)) continue;
          const qs = QUALITY_ORDER.filter((q) => Array.isArray(s?.qualitys) && (s.qualitys as unknown[]).includes(q));
          if (qs.length) this.declared[id] = { name: String(s?.name ?? ""), qualitys: [...qs] };
        }
        if (!Object.keys(this.declared).length) this.loadError = "未声明可用音源";
      }
    }
    if (!this.loadError && !this.handler) this.loadError = "未 on(request) 注册处理器";
    console.log(
      `[lx-source] ${this.scriptName}(${this.scriptPath},md5 ${this.scriptMd5.slice(0, 8)})源:[${Object.keys(this.declared).join(",")}]${this.loadError ? ` 错误:${this.loadError}` : ""}`,
    );
  }

  /** 白名单 lx API;sourceConfig 是宿主注入约定(内置默认源读 ynx key,第三方源忽略) */
  private buildLxApi(onInited: (data: unknown) => void) {
    const plugin = this;
    return {
      EVENT_NAMES: { request: "request", inited: "inited", updateAlert: "updateAlert" },
      on: (ev: string, fn: (payload: { action: string; source: string; info: unknown }) => unknown) => {
        if (ev === "request") plugin.handler = fn;
      },
      send: (ev: string, data: unknown) => {
        if (ev === "inited") onInited(data);
        else if (ev === "updateAlert") console.log("[lx-source] updateAlert:", (data as { log?: string })?.log ?? "");
      },
      request: curlRequest,
      utils: {
        crypto: {
          md5: (s: string) => createHash("md5").update(s).digest("hex"),
          aesEncrypt: (buf: Buffer, mode: string, key: Buffer, iv: Buffer | null) => {
            const c = createCipheriv(mode, key, mode.includes("ecb") ? null : iv);
            return Buffer.concat([c.update(buf), c.final()]);
          },
          rsaEncrypt: (buf: Buffer, pem: string) => publicEncrypt({ key: pem, padding: constants.RSA_PKCS1_PADDING }, buf),
          randomBytes: (n: number) => randomBytes(n),
        },
        buffer: {
          from: (input: string | Iterable<number>, enc?: string) =>
            typeof input === "string" ? Buffer.from(input, enc as BufferEncoding) : Buffer.from(Array.from(input)),
          bufToString: (buf: Buffer, enc?: string) => Buffer.from(buf).toString((enc as BufferEncoding) ?? "utf8"),
        },
      },
      env: "desktop",
      version: "2.0.0",
      sourceConfig: {
        get ynxApiKey() {
          return plugin.ctx?.getShared("ynx.apiKey") ?? "";
        },
      },
    };
  }

  async resolve(
    { source, id, quality, meta }: { source: string; id?: string; url?: string; quality?: string; meta?: { title?: string; artist?: string; album?: string } },
    _ctx: PluginCtx,
  ): Promise<ResolvedAudio> {
    if (this.loadError) throw new Error("lx 源未就绪");
    const declared = this.declared[source];
    if (!declared || !this.handler) throw new Error(`lx 源不支持 ${source}`);
    if (!id) throw new Error("lx 源需要 id");
    // 与 HMusic 同策:全平台 ID 位都填当前平台真实 ID,源内元搜索用 name/singer
    const musicInfo = {
      name: meta?.title ?? "",
      singer: meta?.artist ?? "",
      album: meta?.album ?? "",
      duration: 0,
      interval: 0,
      id,
      songmid: id,
      hash: id,
      strMediaMid: id,
    };
    const requested = [quality, "320k", "128k"].filter((q): q is string => typeof q === "string");
    const candidates = [...new Set(requested)].filter((q) => declared.qualitys.includes(q));
    if (!candidates.length) candidates.push(declared.qualitys[0]);
    let lastErr: unknown;
    for (const type of candidates) {
      try {
        const u = await Promise.race([
          Promise.resolve().then(() => this.handler!({ action: "musicUrl", source, info: { musicInfo, type } })),
          new Promise((_, rej) => setTimeout(() => rej(new Error("timeout 30s")), 30_000)),
        ]);
        const url = String(u ?? "");
        if (!/^https?:/.test(url) || url.length > 2048) throw new Error("返回非法");
        return {
          fileUrl: url,
          ext: type.startsWith("flac") ? "flac" : extFromUrl(url),
          title: meta?.title ?? "",
          artist: meta?.artist ?? "",
          album: meta?.album ?? "",
        };
      } catch (e) {
        lastErr = e;
        console.warn(`[lx-source] musicUrl ${source}/${type} 失败:`, String((e as Error)?.message ?? e));
      }
    }
    console.error("[lx-source] 全档位失败:", lastErr);
    throw new Error("lx 取链失败");
  }
}

export const lxDownload = new LxDownloadPlugin();
