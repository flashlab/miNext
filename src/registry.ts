// 音箱实例注册表:运行时增删改,端口即时重绑,无需重启进程
import type { ServerWebSocket } from "bun";
import { SpeakerLink } from "./protocol/link";
import { PlayerEngine, type PlayerConfig } from "./player/engine";
import { VoicePipeline } from "./player/voice";
import type { CommandsConfig } from "./config";
import type { LibraryDb, SpeakerRow } from "./library/db";
import type { Indexer } from "./library/indexer";
import type { SearchSemantics } from "./library/search";

export interface SpeakerRuntime {
  row: SpeakerRow;
  link: SpeakerLink;
  engine: PlayerEngine;
  voice: VoicePipeline;
  server: ReturnType<typeof Bun.serve>;
}

export interface RegistryDeps {
  db: LibraryDb;
  indexer: Indexer;
  playerCfg: PlayerConfig;
  getCommands: () => CommandsConfig;
  getSearchSem: () => SearchSemantics;
  maxResults: number;
  fileUrl: (path: string) => string;
}

export class SpeakerRegistry {
  private runtimes = new Map<string, SpeakerRuntime>();

  constructor(private deps: RegistryDeps) {}

  get(id: string): SpeakerRuntime | undefined {
    return this.runtimes.get(id);
  }

  all(): SpeakerRuntime[] {
    return [...this.runtimes.values()];
  }

  /** 启动/重绑一台音箱的 WS 端口 */
  bind(row: SpeakerRow): SpeakerRuntime {
    const deps = this.deps;
    const existing = this.runtimes.get(row.id);
    if (existing) this.unbind(row.id);

    const commands = deps.getCommands();
    const link = new SpeakerLink(row.id, row.name, row.ws_port);
    const engine = new PlayerEngine(link, this.deps.playerCfg, this.deps.fileUrl, (m) =>
      console.log(`[${row.id}] ${m}`),
    );
    const voice = new VoicePipeline(link, engine, this.deps.db, this.deps.indexer, commands, this.deps.getSearchSem());
    voice.attach();

    const server = Bun.serve({
      port: row.ws_port,
      fetch(req, srv) {
        // token 门控:公网部署时音箱 URL 需带 /ws/<token>
        if (row.token) {
          const p = new URL(req.url).pathname.replace(/\/+$/, "");
          if (p !== `/ws/${row.token}`) return new Response("unauthorized", { status: 401 });
        }
        if (srv.upgrade(req, { data: undefined })) return;
        return new Response("open-xiaoai ws endpoint", { status: 200 });
      },
      websocket: {
        open(ws: ServerWebSocket<any>) {
          link.attach(ws);
          if (link.lastIp) deps.db.updateSpeaker(row.id, { last_ip: link.lastIp });
        },
        close(ws: ServerWebSocket<any>) { link.detach(ws); },
        message(ws: ServerWebSocket<any>, message: string | Buffer) { link.handleMessage(message); },
      },
    });
    console.log(`WS 监听 :${row.ws_port} → ${row.name}`);

    const rt: SpeakerRuntime = { row, link, engine, voice, server };
    this.runtimes.set(row.id, rt);
    return rt;
  }

  unbind(id: string) {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    try { rt.server.stop(true); } catch { /* noop */ }
    this.runtimes.delete(id);
  }

  /** 改配置:端口变了重绑,其他热更新 */
  reconfigure(row: SpeakerRow) {
    const rt = this.runtimes.get(row.id);
    if (!rt) return this.bind(row);
    if (rt.row.ws_port !== row.ws_port) return this.bind(row);
    rt.row = row;
    rt.link.name = row.name;
    rt.voice.setCommands(this.deps.getCommands());
  }

  /** 全局命令/搜索语义热应用(设置页保存时调用) */
  applyCommands(cmds: CommandsConfig) {
    for (const rt of this.runtimes.values()) rt.voice.setCommands(cmds);
  }
  applySearchSem(sem: SearchSemantics) {
    for (const rt of this.runtimes.values()) rt.voice.setSem(sem);
  }

  remove(id: string) {
    this.unbind(id);
    this.deps.db.deleteSpeaker(id);
  }
}
