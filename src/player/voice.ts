// 语音指令管道(每实例 commands):ASR 文本 → 分类 → 打断处理 → 分发
import type { CommandsConfig } from "../config";
import type { LibraryDb } from "../library/db";
import type { Indexer } from "../library/indexer";
import { searchByVoiceKeyword, isExactCommand, matchesAnyKeyword, extractPlayKeyword, type SearchSemantics } from "../library/search";
import type { PlayerEngine } from "./engine";
import type { SpeakerLink } from "../protocol/link";

export class VoicePipeline {
  constructor(
    private link: SpeakerLink,
    private engine: PlayerEngine,
    private db: LibraryDb,
    private indexer: Indexer,
    private commands: CommandsConfig,
    private sem: SearchSemantics,
  ) {}

  setCommands(cmds: CommandsConfig) {
    this.commands = cmds;
  }

  attach() {
    this.link.setHandlers({
      onInstructionText: (text) => void this.dispatch(text),
      onSpeakEvent: () => this.engine.onSpeakEvent(),
      onConnect: () => {
        console.log(`[${this.link.id}] 音箱已连接`);
        void this.link.probeDeviceInfo();
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
    const isNewPlay = Boolean(keyword) || isRandom;

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
