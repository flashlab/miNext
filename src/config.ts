import { resolve } from "node:path";

export interface SpeakerConfig {
  id: string;
  name: string;
  wsPort: number;
}

export interface CommandsConfig {
  playKeywords: string[];
  stopKeywords: string[];
  previousKeywords: string[];
  nextKeywords: string[];
  refreshKeywords: string[];
  randomPlayKeywords: string[];
  continueKeywords: string[];
  interruptWhitelistKeywords: string[];
  deleteKeywords: string[];
  undoDeleteKeywords: string[];
}

export interface AppConfig {
  httpPort: number;
  lanHost: string;
  musicDirs: string[];
  audioExtensions: string[];
  dbPath: string;
  search: {
    maxResults: number;
    artistSeparators: string[];
    albumSeparators: string[];
  };
  player: {
    timerBufferSec: number;
    replyInterruptCooldownSec: number;
    replyInterruptTimeoutSec: number;
    autoResumeDelaySec: number;
  };
  speakers: SpeakerConfig[];
  commands: CommandsConfig;
}

export async function loadConfig(path = "minext.config.json"): Promise<AppConfig> {
  const file = Bun.file(resolve(path));
  if (!(await file.exists())) {
    throw new Error(`配置文件不存在: ${resolve(path)}`);
  }
  const cfg = (await file.json()) as AppConfig;
  if (!cfg.speakers?.length) throw new Error("配置缺少 speakers");
  if (!cfg.musicDirs?.length) throw new Error("配置缺少 musicDirs");
  // 老配置文件补默认关键词(回收站删除/撤销)
  cfg.commands.deleteKeywords ??= ["删除当前", "删除音乐"];
  cfg.commands.undoDeleteKeywords ??= ["撤销删除", "撤销"];
  return cfg;
}
