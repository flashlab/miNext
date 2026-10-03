// 插件注册表:设置存取(sqlite settings)+ 音源互斥校验
import type { LibraryDb } from "../library/db";
import type { AnyPlugin, DownloadPlugin, PluginCtx, SearchPlugin } from "./types";
import { chkszDownload, chkszSearch } from "./chksz";
import { ynxSearch } from "./ynx";
import { lxDownload } from "./lxhost";
import { directSearch } from "./direct";

export interface SourceSetting {
  enabled: boolean;
  limit?: number;       // 搜索:最大返回
  qualities?: string[]; // 下载:允许的音质
}

export interface PluginPublicView {
  id: string;
  kind: "search" | "download";
  name: string;
  sources: { id: string; name: string; enabled: boolean; limit?: number; qualities?: string[]; supportedQualities?: string[] }[];
  extra: Record<string, unknown>; // 插件自有设置(如 relayUrl;token 不下发完整值)
}

export class PluginRegistry {
  // 注册序即运行时互斥优先级:directSearch 居首,遗留双开状态下直连赢(保存时另有 409 校验)
  readonly plugins: AnyPlugin[] = [directSearch, chkszSearch, chkszDownload, ynxSearch, lxDownload];

  constructor(private db: LibraryDb) {}

  ctx: PluginCtx = {
    getSetting: (id) => this.getPluginSettings(id),
    getShared: (key) => this.db.getSetting(`shared.${key}`) ?? "",
  };

  getPluginSettings(id: string): Record<string, unknown> {
    const raw = this.db.getSetting(`plugin.${id}`);
    if (!raw) return {};
    try { return JSON.parse(raw) as Record<string, unknown>; } catch { return {}; }
  }

  private sourceSetting(p: AnyPlugin, sourceId: string): SourceSetting {
    const s = this.getPluginSettings(p.id) as { sources?: Record<string, SourceSetting> };
    const v = s.sources?.[sourceId];
    if (v) return v;
    // 默认:chksz 三源全开;声明了 defaultEnabledSources 的插件(如枫雨)仅开白名单内的源
    const enabled = p.defaultEnabledSources ? p.defaultEnabledSources.includes(sourceId) : true;
    return { enabled, limit: 20, qualities: p.kind === "download" ? (p.qualities?.[sourceId] ?? []) : undefined };
  }

  sourceEnabled(p: AnyPlugin, sourceId: string): boolean {
    return this.sourceSetting(p, sourceId).enabled;
  }

  /** 同类插件间音源唯一:返回冲突描述,无冲突返回 null */
  private checkConflict(pluginId: string, kind: "search" | "download", sources: Record<string, SourceSetting>): string | null {
    for (const other of this.plugins) {
      if (other.id === pluginId || other.kind !== kind) continue;
      for (const src of other.sources) {
        if (sources[src.id]?.enabled && this.sourceEnabled(other, src.id)) {
          return `音源 ${src.id} 已在${kind === "search" ? "搜索" : "下载"}插件「${other.name}」中启用`;
        }
      }
    }
    return null;
  }

  saveSettings(pluginId: string, body: Record<string, unknown>): { ok: true } | { ok: false; error: string } {
    const p = this.plugins.find((x) => x.id === pluginId);
    if (!p) return { ok: false, error: "未知插件" };
    const sources = (body.sources ?? {}) as Record<string, SourceSetting>;
    const conflict = this.checkConflict(pluginId, p.kind, sources);
    if (conflict) return { ok: false, error: conflict };
    this.db.setSetting(`plugin.${pluginId}`, JSON.stringify(body));
    return { ok: true };
  }

  saveShared(key: string, value: string) {
    this.db.setSetting(`shared.${key}`, value);
  }

  view(): PluginPublicView[] {
    return this.plugins.map((p) => {
      const s = this.getPluginSettings(p.id) as Record<string, unknown> & { sources?: Record<string, SourceSetting> };
      const { sources: _omit, token: _t, ...extra } = s;
      return {
        id: p.id,
        kind: p.kind,
        name: p.name,
        sources: p.sources.map((src) => {
          const ss = this.sourceSetting(p, src.id);
          return {
            id: src.id,
            name: src.name,
            enabled: ss.enabled,
            limit: ss.limit,
            qualities: ss.qualities,
            supportedQualities: p.kind === "download" ? p.qualities?.[src.id] : undefined,
          };
        }),
        extra: { ...extra, hasToken: Boolean((s as { token?: string }).token), ...(p.kind === "download" ? (p.runtimeInfo?.() ?? {}) : {}) },
      };
    });
  }

  searchPlugins(): SearchPlugin[] { return this.plugins.filter((p): p is SearchPlugin => p.kind === "search"); }

  /** 搜索全部启用音源(HTTP 搜索页与语音在线搜索共用)。运行时互斥:同源注册序靠前者赢 */
  async searchAll(q: string): Promise<{ results: Record<string, unknown>[]; errors: { source: string; error: string }[] }> {
    const view = this.view();
    const searches: Promise<unknown[]>[] = [];
    const claimed = new Set<string>();
    for (const p of this.searchPlugins()) {
      for (const src of p.sources) {
        const sv = view.find((v) => v.id === p.id)?.sources.find((s) => s.id === src.id);
        if (!sv?.enabled) continue;
        if (claimed.has(src.id)) { console.log(`[plugins] 音源 ${src.id} 已被排前的搜索插件接管,跳过 ${p.id}`); continue; }
        claimed.add(src.id);
        searches.push(
          p.search(src.id, q, sv.limit ?? 20, this.ctx)
            .then((r) => r as unknown[])
            .catch((e: Error) => [{ __error: String(e?.message ?? e), __source: src.id }]),
        );
      }
    }
    const settled = await Promise.all(searches);
    const results: Record<string, unknown>[] = [];
    const errors: { source: string; error: string }[] = [];
    for (const r of settled.flat() as Record<string, unknown>[]) {
      if (r.__error) errors.push({ source: String(r.__source ?? "?"), error: String(r.__error) });
      else results.push(r);
    }
    return { results, errors };
  }

  /** 以最低音质解析直链(= 试听版本;不下载)。试听页、语音搜索试听、下载当前试听共用 */
  async resolveLowest(source: string, id: string, meta?: { title?: string; artist?: string; album?: string }, url?: string): Promise<{ fileUrl: string }> {
    const plugin = this.downloadPluginFor(source);
    if (!plugin) throw new Error(`${this.sourceDisplayName(source)}未激活下载插件`);
    const lowest = plugin.qualities?.[source]?.[0];
    return await plugin.resolve({ source, id, url, quality: lowest, meta }, this.ctx);
  }
  downloadPlugins(): DownloadPlugin[] { return this.plugins.filter((p): p is DownloadPlugin => p.kind === "download"); }

  downloadPluginFor(source: string): DownloadPlugin | null {
    for (const p of this.downloadPlugins()) {
      if (p.sources.some((s) => s.id === source) && this.sourceEnabled(p, source)) return p;
    }
    return null;
  }

  /** 平台显示名(跨插件查,供"xx未激活下载插件"这类提示用) */
  sourceDisplayName(source: string): string {
    for (const p of this.plugins) {
      const s = p.sources.find((x) => x.id === source);
      if (s) return s.name;
    }
    return source;
  }

  /** 前端换源/删源后热重载 lx 宿主,返回最新运行时信息(loadFailed/loadError 供 UI 反馈) */
  async reloadLxSource(): Promise<Record<string, unknown>> {
    await lxDownload.load(this.ctx);
    return lxDownload.runtimeInfo();
  }
}
