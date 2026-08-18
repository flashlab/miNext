// 插件契约:搜索插件 + 下载插件(v1.3)
export interface SourceDef {
  id: string; // "wy" | "tx" | "kg" | "url"
  name: string;
}

export interface SearchResultItem {
  plugin: string;
  source: string;
  id: string;
  title: string;
  artist: string;
  album?: string;
  duration?: number;
  cover?: string;
  extra?: Record<string, unknown>;
}

export interface ResolvedAudio {
  fileUrl: string;
  ext: string; // 不含点
  title: string;
  artist: string;
  album: string;
  lrc?: string; // 有则写 sidecar .lrc
}

export interface PluginCtx {
  getSetting(pluginId: string): Record<string, unknown>;
  getShared(key: string): string;
}

export interface SearchPlugin {
  kind: "search";
  id: string;
  name: string;
  sources: SourceDef[];
  /** 声明后:未保存设置时仅这些源默认启用(避免与既有插件默认撞源) */
  defaultEnabledSources?: string[];
  search(source: string, query: string, limit: number, ctx: PluginCtx): Promise<SearchResultItem[]>;
}

export interface DownloadPlugin {
  kind: "download";
  id: string;
  name: string;
  sources: SourceDef[]; // 直链类插件用 [{ id: "url" }]
  defaultEnabledSources?: string[];
  qualities?: Record<string, string[]>; // source → 支持的音质
  resolve(input: { source: string; id?: string; url?: string; quality?: string }, ctx: PluginCtx): Promise<ResolvedAudio>;
}

export type AnyPlugin = SearchPlugin | DownloadPlugin;
