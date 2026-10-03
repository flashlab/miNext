// 语音指令管道(每实例 commands):ASR 文本 → 分类 → 打断处理 → 分发
import type { CommandsConfig } from "../config";
import type { LibraryDb } from "../library/db";
import type { Indexer } from "../library/indexer";
import { searchByVoiceKeyword, isExactCommand, matchesAnyKeyword, extractPlayKeyword, type SearchSemantics } from "../library/search";
import type { PlayerEngine, UrlItem } from "./engine";
import type { SpeakerLink } from "../protocol/link";
import { emitSpeaker } from "../sync";
import { getPreview } from "../dlPreview";

/** 语音在线搜索/下载的宿主能力(由 index.ts 注入,依赖 plugins/jobs) */
export interface DlActions {
  /** 在线搜索:只返回结果列表(不解析直链——预解析易触发上游限制;解析留到播放/下载时按需做) */
  searchList(query: string): Promise<UrlItem[]>;
  /** 按需解析单条试听直链(最低音质=试听版本) */
  resolvePreview(item: { source: string; id: string; title?: string; artist?: string; album?: string }): Promise<string>;
  /** 把试听项加入下载队列(下载到默认下载目录);返回给用户播报的结果 */
  download(item: { source: string; id: string; title?: string; artist?: string; url?: string }): Promise<string>;
}

/** 前缀关键词触发:命中则返回去掉关键词后的剩余文本(空串=只说了关键词),未命中返回 null */
function extractAfterKeyword(text: string, keywords: string[]): string | null {
  for (const k of keywords) {
    if (!k || !text.startsWith(k)) continue;
    return text.slice(k.length).replace(/^[的\s,]+/, "").trim();
  }
  return null;
}

/** 数量提取:阿拉伯数字或中文数字(五/十/二十/二十五…) */
function parseCount(s: string): number | null {
  const m = s.match(/\d+/);
  if (m) return parseInt(m[0], 10);
  const cn: Record<string, number> = { 零: 0, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const t = s.match(/[零一两二三四五六七八九十]+/)?.[0];
  if (!t) return null;
  if (t === "十") return 10;
  if (t.length === 1) return cn[t] ?? null;
  const i = t.indexOf("十");
  if (i < 0) return null;
  const head = i === 0 ? 1 : (cn[t[0]] ?? 0);
  const tail = i === t.length - 1 ? 0 : (cn[t[i + 1]] ?? 0);
  return head * 10 + tail;
}

/** 最近曲目命令:关键词 [+ 数字/中文数字] [+ 首/首歌/曲];尾巴不像计数则不算命中(如「最近怎么样」) */
function matchRecentCommand(text: string, keywords: string[]): string | null {
  for (const k of keywords) {
    if (!k || !text.startsWith(k)) continue;
    const rest = text.slice(k.length).trim();
    if (rest === "" || /^(?:[0-9]+|[零一两二三四五六七八九十]+)(?:首|首歌|曲)?$/.test(rest)) return rest;
  }
  return null;
}

export class VoicePipeline {
  constructor(
    private link: SpeakerLink,
    private engine: PlayerEngine,
    private db: LibraryDb,
    private indexer: Indexer,
    private commands: CommandsConfig,
    private sem: SearchSemantics,
    private dl: DlActions,
  ) {}

  setCommands(cmds: CommandsConfig) {
    this.commands = cmds;
  }

  setSem(sem: SearchSemantics) {
    this.sem = sem;
  }

  attach() {
    this.link.setHandlers({
      onInstructionText: (text) => void this.dispatch(text),
      onSpeakEvent: (text) => this.engine.onSpeakEvent(text),
      onConnect: () => {
        console.log(`[${this.link.id}] 音箱已连接`);
        void this.link
          .probeDeviceInfo()
          .then(() => emitSpeaker(this.link.id, { device: this.link.deviceInfo }))
          .catch(() => {});
      },
      onDisconnect: () => console.log(`[${this.link.id}] 音箱已断开`),
    });
  }

  private async dispatch(text: string) {
    const cmds = this.commands;
    console.log(`[${this.link.id}] ASR: ${text}`);

    const isStop = isExactCommand(text, cmds.stopKeywords);
    const isPrev = isExactCommand(text, cmds.previousKeywords);
    const isNext = isExactCommand(text, cmds.nextKeywords);
    const isRefresh = isExactCommand(text, cmds.refreshKeywords);
    const isRandom = isExactCommand(text, cmds.randomPlayKeywords);
    const isContinue = isExactCommand(text, cmds.continueKeywords);
    const isDelete = isExactCommand(text, cmds.deleteKeywords);
    const isUndo = isExactCommand(text, cmds.undoDeleteKeywords);
    const keyword = extractPlayKeyword(text, cmds.playKeywords);
    const isDownload = isExactCommand(text, cmds.downloadKeywords);
    const searchQ = extractAfterKeyword(text, cmds.searchKeywords);
    const recentRaw = matchRecentCommand(text, cmds.recentKeywords);
    const isNewPlay = Boolean(keyword) || isRandom || searchQ !== null || recentRaw !== null;

    if (matchesAnyKeyword(text, cmds.interruptWhitelistKeywords)) {
      this.engine.scheduleWhitelistAutoResume();
      return;
    }
    await this.engine.handleUserSpeechInterrupt(!isNewPlay);

    if (isStop) {
      this.engine.disarmReplyInterrupt("voice stop");
      await this.engine.stop();
      return;
    }
    if (isPrev) {
      this.engine.armReplyInterrupt("voice prev");
      await this.engine.prev();
      return;
    }
    if (isNext) {
      this.engine.armReplyInterrupt("voice next");
      await this.engine.next();
      return;
    }
    if (isRefresh) {
      this.engine.armReplyInterrupt("voice refresh");
      await this.refreshWithReply();
      return;
    }
    if (isRandom) {
      this.engine.armReplyInterrupt("voice random");
      await this.playRandom();
      return;
    }
    if (isContinue) {
      this.engine.armReplyInterrupt("voice continue");
      if (this.link.playing !== "Playing") await this.engine.toggle();
      return;
    }
    if (isDelete) {
      await this.deleteCurrent();
      return;
    }
    if (isUndo) {
      await this.undoDelete();
      return;
    }
    if (isDownload) {
      await this.downloadCurrent();
      return;
    }
    if (searchQ !== null) {
      await this.searchAndPlay(searchQ);
      return;
    }
    if (recentRaw !== null) {
      await this.playRecent(recentRaw);
      return;
    }
    if (keyword) {
      this.engine.armReplyInterrupt(`voice play: ${keyword}`);
      await this.playByKeyword(keyword);
    }
  }

  /** 语音删除当前曲目:标记回收站(文件保留) → 记录撤销槽 → 跳下首/停止 */
  async deleteCurrent() {
    const cur = this.engine.current;
    if (!cur) {
      await this.engine.speak("当前没有播放");
      return;
    }
    this.engine.armReplyInterrupt("voice delete");
    this.db.markDeleted(cur.path);
    this.db.setSettingJSON("voice.lastTrash", { path: cur.path, title: cur.title, artist: cur.artist, at: Date.now() });
    await this.engine.speak(`已删除:${cur.title || cur.filename}`);
    await this.engine.advanceAfterDelete();
  }

  /** 撤销上次语音删除(仅清标记,不回播放列表);记录已物理删除/已恢复则不可撤销 */
  async undoDelete() {
    this.engine.armReplyInterrupt("voice undo");
    const slot = this.db.getSettingJSON<{ path: string; title: string }>("voice.lastTrash");
    if (!slot?.path) {
      await this.engine.speak("没有可撤销的删除");
      return;
    }
    const row = this.db.getByPathAny(slot.path);
    if (!row || !row.deleted_at) {
      this.db.setSetting("voice.lastTrash", "");
      await this.engine.speak("无法撤销");
      return;
    }
    this.db.restore([slot.path]);
    this.db.setSetting("voice.lastTrash", "");
    await this.engine.speak("已撤销删除");
  }

  async playByKeyword(keyword: string) {
    const songs = searchByVoiceKeyword(this.db, keyword, this.sem);
    if (!songs.length) {
      await this.engine.speak(`没有找到包含${keyword}的歌曲`);
      return;
    }
    await this.engine.speak(`找到${songs.length}首歌曲`);
    await this.engine.playQueue(songs);
  }

  async playRandom() {
    const songs = this.db.randomPick(this.sem.maxResults);
    if (!songs.length) {
      await this.engine.speak("曲库为空,无法随机播放");
      return;
    }
    await this.engine.speak(`好的,随机播放${songs.length}首歌曲`);
    await this.engine.playQueue(songs);
  }

  /** 语音在线搜索:整列顺序试听;直链按播放/下载时机逐条解析,失败自动顺延,不限试听总数 */
  async searchAndPlay(query: string) {
    const q = query.trim();
    if (!q) {
      await this.engine.speak("请说搜索什么歌曲");
      return;
    }
    this.engine.armReplyInterrupt("voice search");
    await this.engine.speak(`正在搜索${q}`);
    let items: UrlItem[] = [];
    try {
      items = await this.dl.searchList(q);
    } catch (e) {
      console.error(`[${this.link.id}] voice search failed:`, e);
      await this.engine.speak("搜索失败,请稍后再试");
      return;
    }
    if (!items.length) {
      await this.engine.speak(`没有找到${q}的试听歌曲`);
      return;
    }
    await this.engine.speak(`找到${items.length}首,开始播放`);
    await this.engine.playUrlQueue(items, `voice search: ${q}`);
  }

  /** 下载当前试听版本(语音搜索播放中,或网页手动试听中) */
  async downloadCurrent() {
    const live = this.engine.currentUrl;
    const pv = live ? null : getPreview();
    const item = live
      ? { source: live.source, id: live.id, title: live.title, artist: live.artist, url: live.url }
      : pv
        ? { source: pv.source, id: pv.id, title: pv.title ?? "", artist: pv.artist ?? "", url: undefined }
        : null;
    if (!item) {
      await this.engine.speak("没有正在试听的曲目");
      return;
    }
    this.engine.armReplyInterrupt("voice download");
    try {
      const msg = await this.dl.download(item);
      await this.engine.speak(msg);
    } catch (e) {
      console.error(`[${this.link.id}] download failed:`, e);
      await this.engine.speak(`下载失败:${String((e as Error).message || e).slice(0, 30)}`);
    }
  }

  /** 最新添加的 N 首(未说数字默认 10;受播放列表上限限制) */
  async playRecent(raw: string) {
    const wanted = parseCount(raw) ?? 10;
    const n = Math.max(1, Math.min(wanted, this.sem.maxResults || 20));
    const songs = this.db.newest(n);
    if (!songs.length) {
      await this.engine.speak("曲库为空");
      return;
    }
    this.engine.armReplyInterrupt("voice recent");
    await this.engine.speak(`播放最新${songs.length}首`);
    await this.engine.playQueue(songs);
  }

  async refreshWithReply() {
    try {
      if (this.indexer.isRefreshing) {
        await this.engine.speak("曲库正在刷新,请稍等");
        return;
      }
      await this.engine.speak("正在刷新曲库,请稍等");
      const start = Date.now();
      const total = await this.indexer.refresh();
      await this.engine.speak(`曲库刷新完成,共${total}首,耗时${((Date.now() - start) / 1000).toFixed(1)}秒`);
    } catch (e) {
      console.error("refresh failed:", e);
      await this.engine.speak("曲库刷新失败,请稍后重试");
    }
  }
}
