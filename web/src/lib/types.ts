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
}

export interface SpeakerCommands {
  playKeywords?: string[];
  stopKeywords?: string[];
  previousKeywords?: string[];
  nextKeywords?: string[];
  refreshKeywords?: string[];
  randomPlayKeywords?: string[];
  continueKeywords?: string[];
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
  album: string;
  duration: number;
  cover: string;
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
