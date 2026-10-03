export interface Song {
  id: number;
  path: string;
  title: string;
  artist: string;
  album: string;
  filename: string;
  dir: string;
  ext: string;
  duration_sec: number;
  size: number;
  ctime_ns?: number; // 文件创建时间(birthtime,回退 mtime)
  deleted_at?: number; // >0 = 回收站(标记删除)
}

export interface GlobalSettings {
  commands: SpeakerCommands;
  audioExtensions: string[]; // [".mp3", ...]
  search: { maxResults: number; artistSeparators: string[]; albumSeparators: string[] };
}

export type LoopMode = "off" | "one" | "all" | "random";
export type PlayingStatus = "Playing" | "Paused" | "Idle";

export interface PlayerState {
  list: Song[];
  cursor: number;
  loop: LoopMode;
  stopAfterCurrent: boolean;
  volume: number | null;
  playing: PlayingStatus;
  /** 语音在线搜索试听队列(直链播放,不进曲库列表) */
  urlQueue?: { index: number; total: number; title: string; artist: string; source: string; id: string; key: string } | null;
}

export interface SpeakerCommands {
  playKeywords?: string[];
  stopKeywords?: string[];
  previousKeywords?: string[];
  nextKeywords?: string[];
  refreshKeywords?: string[];
  randomPlayKeywords?: string[];
  continueKeywords?: string[];
  searchKeywords?: string[];
  downloadKeywords?: string[];
  recentKeywords?: string[];
  deleteKeywords?: string[];
  undoDeleteKeywords?: string[];
  interruptWhitelistKeywords?: string[];
}

export interface Speaker {
  id: string;
  name: string;
  wsPort: number;
  commands: SpeakerCommands;
  hidden: boolean;
  token: string;
  lastIp: string;
  online: boolean;
  lastEventAt: number | null;
  playing: PlayingStatus;
  device: { model?: string; sn?: string };
  micMuted: boolean | null; // 麦克风真实状态(null=离线未知)
  nativeVoiceDisabledUntil: number | null; // 原生语音禁用到期时间戳
  player: { loop: LoopMode; current: Song | null; queueLength: number };
}

export interface AlbumInfo {
  album: string;
  artist: string;
  count: number;
}

export interface DirsInfo {
  dirs: string[];
  defaultDir: string;
}

// ---- 插件/下载 ----
export interface PluginSourceView {
  id: string;
  name: string;
  enabled: boolean;
  limit?: number;
  qualities?: string[];
  supportedQualities?: string[];
}

export interface PluginView {
  id: string;
  kind: "search" | "download";
  name: string;
  sources: PluginSourceView[];
  extra: Record<string, unknown> & { hasToken?: boolean };
}

export interface DlResult {
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

/** 共享试听态(服务端):谁在哪个实例上试听哪首;untilTs=0 表示保持到停止 */
export interface DlPreview {
  key: string;
  source: string;
  id: string;
  instance: string;
  instanceName: string;
  title?: string;
  artist?: string;
  startedAt: number;
  untilTs: number;
}

export interface DlJob {
  id: number;
  label: string;
  dir: string;
  status: "running" | "done" | "failed";
  error?: string;
  savedPath?: string;
  createdAt: number;
  finishedAt?: number;
}
