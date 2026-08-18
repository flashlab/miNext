// 插件注册表:设置存取(sqlite settings)+ 音源互斥校验
import type { LibraryDb } from "../library/db";
import type { AnyPlugin, DownloadPlugin, PluginCtx, SearchPlugin } from "./types";
import { chkszDownload, chkszSearch } from "./chksz";

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
  readonly plugins: AnyPlugin[] = [chkszSearch, chkszDownload];

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
    // 默认:chksz 搜索/下载三源默认开
    return { enabled: true, limit: 20, qualities: p.kind === "download" ? (p.qualities?.[sourceId] ?? []) : undefined };
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
        extra: { ...extra, hasToken: Boolean((s as { token?: string }).token) },
      };
    });
  }

  searchPlugins(): SearchPlugin[] { return this.plugins.filter((p): p is SearchPlugin => p.kind === "search"); }
  downloadPlugins(): DownloadPlugin[] { return this.plugins.filter((p): p is DownloadPlugin => p.kind === "download"); }

  downloadPluginFor(source: string): DownloadPlugin | null {
    for (const p of this.downloadPlugins()) {
      if (p.sources.some((s) => s.id === source) && this.sourceEnabled(p, source)) return p;
    }
    return null;
  }
}
