// 播放引擎 v2:list + cursor 模型(列表即全部,已播项保留)
// 循环模式 / 播完即停 / 音量 / 列表编辑不影响当前播放
import type { SpeakerLink } from "../protocol/link";
import { emitNotify } from "../sync";
import { setPreview } from "../dlPreview";
import type { SongRow } from "../library/db";

export type LoopMode = "off" | "one" | "all" | "random";

export interface PlayerConfig {
  timerBufferSec: number;
  replyInterruptCooldownSec: number;
  replyInterruptTimeoutSec: number;
  autoResumeDelaySec: number;
}

export interface PlayerSnapshot {
  list: SongRow[];
  cursor: number; // -1 = 空/未开始
  loop: LoopMode;
  stopAfterCurrent: boolean;
  volume: number | null;
  playing: "Playing" | "Paused" | "Idle";
  urlQueue: { index: number; total: number; title: string; artist: string; source: string; id: string; key: string } | null;
}

/** 直链试听项(语音在线搜索播放;不进曲库列表) */
export interface UrlItem {
  key: string;      // `${source}:${id}`
  source: string;
  id: string;
  title: string;
  artist: string;
  album?: string;
  duration: number; // 秒;0=未知(不自动续播)
  /** 试听直链:播放/下载时才按需解析并缓存(不预解析整列,避免触发上游限制) */
  url?: string;
}

/** 按需解析试听直链(最低音质=试听版本);由 index.ts 注入 */
export interface UrlResolver {
  resolvePreview(item: { source: string; id: string; title?: string; artist?: string; album?: string }): Promise<string>;
}

/** 连续解析/起播失败达到该值 → 停止整列(防失效源把队列刷屏) */
const URL_FAIL_STREAK_LIMIT = 5;

const sleep = (sec: number) => new Promise((r) => setTimeout(r, sec * 1000));

export class PlayerEngine {
  loop: LoopMode = "off";
  stopAfterCurrent = false;

  private list: SongRow[] = [];
  private cursor = -1;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** 直链试听队列(语音搜索):与曲库列表互不干扰,曲库列表与位置保留 */
  private urls: UrlItem[] = [];
  private urlCursor = -1;
  private urlMode = false;
  private urlFailStreak = 0; // 连续解析/起播失败计数
  private playedForRandom = new Set<number>(); // random 模式防重复

  private replyInterruptArmed = false;
  private replyInterruptArmedAt = 0;
  private replyInterruptLastStopAt = 0;
  /** 最近一个"带文本" Speak 事件的归属(无文本伴生事件跟随它判定) */
  private lastSpeakOwn = false;
  private lastSpeakAt = 0;
  private whitelistResumeTimer: ReturnType<typeof setTimeout> | null = null;
  private whitelistResumeSeq = 0;
  private busy = false;

  constructor(
    private link: SpeakerLink,
    private cfg: PlayerConfig,
    private fileUrl: (path: string) => string,
    private log: (msg: string) => void = console.log,
    private resolveUrl?: UrlResolver,
  ) {}

  get current(): SongRow | null {
    return this.cursor >= 0 && this.cursor < this.list.length ? this.list[this.cursor] : null;
  }

  /** 直链试听队列是否在放 */
  get urlQueueActive(): boolean {
    return this.urlMode;
  }

  /** 当前直链试听项(供「下载当前」用) */
  get currentUrl(): UrlItem | null {
    return this.urlMode && this.urlCursor >= 0 && this.urlCursor < this.urls.length ? this.urls[this.urlCursor] : null;
  }

  async snapshot(): Promise<PlayerSnapshot> {
    let volume: number | null = null;
    if (this.link.online) {
      try { volume = await this.link.getVolume(); } catch { volume = null; }
    }
    return {
      list: [...this.list],
      cursor: this.cursor,
      loop: this.loop,
      stopAfterCurrent: this.stopAfterCurrent,
      volume,
      playing: this.link.playing,
      urlQueue: this.currentUrl
        ? { index: this.urlCursor, total: this.urls.length, title: this.currentUrl.title,
            artist: this.currentUrl.artist, source: this.currentUrl.source, id: this.currentUrl.id, key: this.currentUrl.key }
        : null,
    };
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    while (this.busy) await sleep(0.05);
    this.busy = true;
    try { return await fn(); } finally { this.busy = false; }
  }

  // ---- 打断机制(与 v1 相同语义) ----

  armReplyInterrupt(reason: string) {
    this.replyInterruptArmed = true;
    this.replyInterruptArmedAt = Date.now();
    this.log(`reply interrupt armed: ${reason}`);
  }

  /** 禁用原生语音窗口(到期时间戳 ms,0=未禁用):窗口内小爱的所有回答都被切断(自家 TTS 除外) */
  nativeVoiceDisabledUntil = 0;

  get nativeVoiceDisabled(): boolean {
    return this.nativeVoiceDisabledUntil > Date.now();
  }

  setNativeVoiceDisabled(untilMs: number) {
    this.nativeVoiceDisabledUntil = Math.max(0, Math.round(untilMs));
    this.log(this.nativeVoiceDisabled
      ? `native voice disabled until ${new Date(this.nativeVoiceDisabledUntil).toISOString()}`
      : "native voice enabled");
  }

  disarmReplyInterrupt(reason: string) {
    if (!this.replyInterruptArmed) return;
    this.replyInterruptArmed = false;
  }

  private isReplyInterruptArmed(): boolean {
    if (!this.replyInterruptArmed) return false;
    if (Date.now() - this.replyInterruptArmedAt > this.cfg.replyInterruptTimeoutSec * 1000) {
      this.replyInterruptArmed = false;
      return false;
    }
    return true;
  }

  onSpeakEvent(text?: string) {
    const now = Date.now();
    // 音箱每次播报都会发一对事件(带文本 + 紧随其后无文本):
    // 无文本的伴生事件按"5s 内最近一个带文本事件的归属"判定,避免禁用期间切断自家 TTS
    let own: boolean;
    if (text) {
      own = this.link.isRecentOwnTts(text);
      this.lastSpeakOwn = own;
      this.lastSpeakAt = now;
    } else {
      own = now - this.lastSpeakAt < 5000 ? this.lastSpeakOwn : false;
    }
    const armed = this.isReplyInterruptArmed();
    const native = this.nativeVoiceDisabled;
    const cooling = now - this.replyInterruptLastStopAt < this.cfg.replyInterruptCooldownSec * 1000;
    this.log(`speak event: armed=${armed} native=${native} cooling=${cooling} own=${own} text=${(text ?? "").slice(0, 40)}`);
    if (own) return; // 自家 TTS 播报,不切
    if ((!armed && !native) || cooling) return;
    this.replyInterruptLastStopAt = now;
    this.log(`reply interrupt hit (armed=${armed} native=${native}): 切断回答 ${(text ?? "").slice(0, 30)}`);
    this.link.pausePlayback().catch(() => {});
  }

  async handleUserSpeechInterrupt(_preserveQueue: boolean) {
    this.cancelTimer();
    this.replyInterruptArmed = false;
  }

  scheduleWhitelistAutoResume() {
    const urlMode = this.urlMode;
    if (urlMode ? !this.currentUrl : !this.current) return;
    const seq = ++this.whitelistResumeSeq;
    if (this.whitelistResumeTimer) clearTimeout(this.whitelistResumeTimer);
    this.whitelistResumeTimer = setTimeout(() => {
      if (seq !== this.whitelistResumeSeq) return;
      if (this.urlMode) {
        if (!this.currentUrl) return;
        this.cancelTimer();
        void this.startUrl(this.urlCursor, "whitelist auto resume");
        return;
      }
      if (!this.current) return;
      this.cancelTimer();
      this.startSong(this.current, "whitelist auto resume");
    }, Math.max(this.cfg.autoResumeDelaySec, 0.1) * 1000);
  }

  // ---- 核心调度 ----

  private cancelTimer() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  /** 语音搜索试听:整体替换直链队列并从头顺序播(压掉曲库队列播放,列表与位置保留) */
  async playUrlQueue(items: UrlItem[], note: string) {
    await this.withLock(async () => {
      this.cancelTimer();
      if (!items.length) return;
      await this.link.pausePlayback().catch(() => {});
      this.urls = [...items];
      this.urlCursor = -1;
      this.urlMode = true;
      this.urlFailStreak = 0;
      this.log(`url queue start: ${items.length} 首 (${note})`);
      await this.startUrl(0, note);
    });
  }

  /** 起播直链队列第 idx 项:直链按需解析(缓存复用);解析或起播失败自动顺延下一首 */
  private async startUrl(idx: number, trigger: string) {
    const it = this.urls[idx];
    if (!it) { this.finishUrlQueue("队列播完"); return; }
    this.replyInterruptArmed = false;
    this.urlCursor = idx;
    let url = it.url ?? "";
    if (!url) {
      try {
        if (!this.resolveUrl) throw new Error("未接入直链解析器");
        url = await this.resolveUrl.resolvePreview({ source: it.source, id: it.id, title: it.title, artist: it.artist, album: it.album });
        if (!url) throw new Error("解析结果为空");
        it.url = url; // 缓存:重播同一首、下载当前都直接用
      } catch (e) {
        this.urlFailStreak++;
        this.log(`试听解析失败(${it.title || it.key}): ${e} → 顺延下一首`);
        if (this.urlFailStreak >= URL_FAIL_STREAK_LIMIT) {
          await this.speak("试听源暂时不可用");
          this.finishUrlQueue(`连续解析失败 ${this.urlFailStreak} 首`);
          return;
        }
        if (idx + 1 < this.urls.length) await this.startUrl(idx + 1, `${trigger} skip`);
        else this.finishUrlQueue("全部失败");
        return;
      }
    }
    try {
      await this.link.playUrl(url);
    } catch (e) {
      this.urlFailStreak++;
      this.log(`试听播放失败(${it.title || it.key}): ${e}`);
      emitNotify("error", `无法播放「${it.title || it.key}」`);
      if (this.urlFailStreak >= URL_FAIL_STREAK_LIMIT) {
        emitNotify("error", "试听源连续失败,已停止");
        this.finishUrlQueue(`连续起播失败 ${this.urlFailStreak} 首`);
        return;
      }
      if (idx + 1 < this.urls.length) await this.startUrl(idx + 1, `${trigger} skip`);
      else this.finishUrlQueue("全部失败");
      return;
    }
    this.urlFailStreak = 0;
    this.log(`url start: trigger=${trigger} ${idx + 1}/${this.urls.length} ${it.title}${it.duration > 0 ? ` duration=${it.duration.toFixed(1)}s` : " duration=unknown"}`);
    // 共享试听态:跨标签页/跨设备可见(网页正好搜到同一条时可点停止)
    setPreview({
      key: it.key, source: it.source, id: it.id,
      instance: this.link.id, instanceName: this.link.name,
      title: it.title, artist: it.artist, duration: it.duration,
    });
    this.cancelTimer();
    // 时长未知(0)时不自动续播:保持到手动下一首/停止,避免 1 秒就跳过
    if (it.duration > 0) {
      const waitMs = it.duration * 1000 + this.cfg.timerBufferSec * 1000;
      this.timer = setTimeout(() => void this.onTimer(), waitMs);
    }
  }

  /** 直链队列收尾:清态(定时器/当前项);playing 自然转 Idle */
  private finishUrlQueue(reason: string) {
    this.cancelTimer();
    this.urlMode = false;
    this.urls = [];
    this.urlCursor = -1;
    this.urlFailStreak = 0;
    this.log(`url queue end: ${reason}`);
  }

  /** 只释放直链队列(不打断正在播的声音;供网页手动试听/停止前调用) */
  releaseUrlQueue(note: string) {
    if (!this.urlMode && !this.urls.length) return;
    this.finishUrlQueue(`release: ${note}`);
  }

  private async urlAdvance(trigger: string) {
    if (this.urlCursor + 1 < this.urls.length) await this.startUrl(this.urlCursor + 1, trigger);
    else this.finishUrlQueue(`播完(${trigger})`);
  }

  private async startSong(song: SongRow, trigger: string) {
    this.replyInterruptArmed = false;
    const url = this.fileUrl(song.path);
    try {
      await this.link.playUrl(url);
    } catch (e) {
      this.log(`播放失败(${song.filename}): ${e}`);
      emitNotify("error", `无法播放「${song.filename}」`);
      return;
    }
    this.log(`start song: trigger=${trigger} name=${song.filename} duration=${song.duration_sec.toFixed(1)}s`);
    this.cancelTimer();
    const waitMs = Math.max(song.duration_sec, 0.1) * 1000 + this.cfg.timerBufferSec * 1000;
    this.timer = setTimeout(() => void this.onTimer(), waitMs);
  }

  /** 定时器到点 = 当前曲播完 */
  private async onTimer() {
    this.timer = null;
    await this.withLock(async () => {
      if (this.urlMode) { await this.urlAdvance("auto"); return; }
      if (!this.current) return;

      if (this.stopAfterCurrent) {
        this.stopAfterCurrent = false;
        this.log("播完当前即停");
        return; // cursor 不动,playing 自然转 Idle
      }
      if (this.loop === "one") {
        await this.startSong(this.current, "loop one");
        return;
      }
      await this.advance("auto");
    });
  }

  /** 前进到下一首(依 loop)。返回是否成功起播。 */
  private async advance(trigger: string): Promise<boolean> {
    let nextIdx = -1;
    if (this.loop === "random") {
      this.playedForRandom.add(this.cursor);
      const remaining = this.list.map((_, i) => i).filter((i) => !this.playedForRandom.has(i));
      if (!remaining.length) {
        this.playedForRandom.clear();
        if (this.list.length) {
          nextIdx = Math.floor(Math.random() * this.list.length);
        }
      } else {
        nextIdx = remaining[Math.floor(Math.random() * remaining.length)];
      }
    } else if (this.cursor + 1 < this.list.length) {
      nextIdx = this.cursor + 1;
    } else if (this.loop === "all" && this.list.length) {
      nextIdx = 0;
    }
    if (nextIdx < 0) return false;
    this.cursor = nextIdx;
    await this.startSong(this.list[nextIdx], trigger);
    return true;
  }

  // ---- 对外操作 ----

  /** 整体替换列表并从头播 */
  async playQueue(songs: SongRow[]) {
    await this.withLock(async () => {
      this.cancelTimer();
      this.list = [...songs];
      this.cursor = 0;
      this.playedForRandom.clear();
      await this.link.pausePlayback().catch(() => {});
      if (this.list.length) await this.startSong(this.list[0], "play queue");
    });
  }

  /** 追加到列表尾部(不打断当前播放;若空闲则开始播) */
  /** 追加到列表尾部。去重:同一曲目(path 相同)已存在时,先移出旧队列里的条目再追加到尾部,列表不出现重复 */
  async appendQueue(songs: SongRow[]) {
    await this.withLock(async () => {
      const wasEmpty = this.list.length === 0;
      const cur = this.current; // 追加前正在播的那首(其旧条目可能被本次去重移出)
      // 批次内也去重:同 path 只保留一首
      const seen = new Set<string>();
      const batch = songs.filter((s) => (seen.has(s.path) ? false : (seen.add(s.path), true)));
      const incoming = new Set(batch.map((s) => s.path));
      if (incoming.size && this.list.some((s) => incoming.has(s.path))) {
        this.list = this.list.filter((s) => !incoming.has(s.path)); // 移出旧条目(可能多条)
        if (cur) {
          this.cursor = this.list.findIndex((s) => s.path === cur.path); // 可能 -1,追加后再定位
        } else if (this.cursor >= this.list.length) {
          this.cursor = this.list.length - 1;
        }
      }
      this.list.push(...batch);
      if (cur) {
        // 当前曲旧条目被移出后,新位置在追加段里 → cursor 跟随,否则 advance 会跳到别的歌
        const ni = this.list.findIndex((s) => s.path === cur.path);
        if (ni >= 0) this.cursor = ni;
      }
      if (wasEmpty && this.cursor === -1 && this.list.length) {
        this.cursor = 0;
        await this.startSong(this.list[0], "append auto play");
      }
    });
  }

  /** 停止/继续合并 toggle */
  async toggle(): Promise<"stopped" | "resumed" | "noop"> {
    return await this.withLock(async () => {
      if (this.urlMode) {
        if (this.link.playing === "Playing") {
          this.cancelTimer();
          await this.link.pausePlayback().catch(() => {});
          return "stopped" as const;
        }
        this.cancelTimer();
        await sleep(this.cfg.replyInterruptCooldownSec);
        await this.startUrl(this.urlCursor >= 0 ? this.urlCursor : 0, "url toggle resume");
        return "resumed" as const;
      }
      if (this.link.playing === "Playing") {
        this.cancelTimer();
        await this.link.pausePlayback().catch(() => {});
        return "stopped" as const;
      }
      // 空闲/暂停:有当前曲则重播(音箱无 seek),否则播 cursor 处
      const song = this.current ?? (this.cursor + 1 < this.list.length ? this.list[this.cursor + 1] : null);
      if (song) {
        this.cancelTimer();
        await sleep(this.cfg.replyInterruptCooldownSec);
        const idx = this.list.indexOf(song);
        if (idx >= 0) this.cursor = idx;
        await this.startSong(song, "toggle resume");
        return "resumed" as const;
      }
      return "noop" as const;
    });
  }

  async next() {
    await this.withLock(async () => {
      this.cancelTimer();
      if (this.urlMode) {
        if (this.urlCursor + 1 >= this.urls.length) { await this.speak("当前没有下一首"); return; }
        await sleep(this.cfg.replyInterruptCooldownSec);
        await this.urlAdvance("manual next");
        return;
      }
      // random 模式下尾部仍可继续(advance 会随机抽未播项),不能按"没有下一首"拒掉
      if (this.cursor + 1 >= this.list.length && this.loop !== "all" && this.loop !== "random") {
        await this.speak("当前没有下一首");
        return;
      }
      await sleep(this.cfg.replyInterruptCooldownSec);
      const ok = await this.advance("manual next");
      if (!ok) await this.speak("当前没有下一首");
    });
  }

  async prev() {
    await this.withLock(async () => {
      if (this.urlMode) {
        if (this.urlCursor <= 0) { await this.speak("当前没有上一首"); return; }
        this.cancelTimer();
        await sleep(this.cfg.replyInterruptCooldownSec);
        await this.startUrl(this.urlCursor - 1, "manual previous");
        return;
      }
      if (this.cursor <= 0) {
        await this.speak("当前没有上一首");
        return;
      }
      this.cancelTimer();
      await sleep(this.cfg.replyInterruptCooldownSec);
      this.cursor -= 1;
      await this.startSong(this.list[this.cursor], "manual previous");
    });
  }

  /** 语音删除当前曲目后:有下首则跳下首,否则停止(回收站语义,文件仍在磁盘) */
  async advanceAfterDelete() {
    await this.withLock(async () => {
      this.cancelTimer();
      if (this.cursor + 1 < this.list.length || this.loop === "all") {
        await sleep(this.cfg.replyInterruptCooldownSec);
        await this.advance("voice delete next");
        return;
      }
      await this.stop();
    });
  }

  /** 停止(保留列表);note=触发来源(如 web 客户端 IP),便于多端排查 */
  async stop(note = "") {
    await this.withLock(async () => {
      this.cancelTimer();
      if (this.urlMode) this.finishUrlQueue(`stop${note ? ` (${note})` : ""}`);
      await this.link.pausePlayback().catch(() => {});
      this.log(`stop(保留列表)${note ? ` (${note})` : ""}`);
    });
  }

  async speak(text: string) {
    // 注意:不要在此 disarm——武装窗口须覆盖自家 TTS 全程,直到 startSong(音乐起播)才撤防,
    // 否则小爱的默认答复(Speak 事件通常在 ASR 后 0.5–2s 到达)永远落在窗口外。
    await this.link.speakText(text).catch((e) => this.log(`TTS 失败: ${e}`));
  }

  // ---- 列表编辑(不影响当前播放) ----

  async listOp(op: "playNow" | "pinTop" | "playNext" | "remove" | "reorder", args: { index?: number; from?: number; to?: number }) {
    await this.withLock(async () => {
      const cur = this.current;

      if (op === "playNow" && args.index !== undefined) {
        const s = this.list[args.index];
        if (!s) return;
        this.cancelTimer();
        this.cursor = args.index;
        await this.startSong(s, "list playNow");
        return;
      }

      if (op === "pinTop" && args.index !== undefined) {
        const [s] = this.list.splice(args.index, 1);
        if (!s) return;
        this.list.unshift(s);
      } else if (op === "playNext" && args.index !== undefined) {
        const [s] = this.list.splice(args.index, 1);
        if (!s) return;
        this.list.splice(this.cursor + 1, 0, s);
      } else if (op === "remove" && args.index !== undefined) {
        const removedCurrent = args.index === this.cursor;
        this.list.splice(args.index, 1);
        if (removedCurrent) {
          // 当前曲继续放完(定时器不动),cursor 指向 null 态
          this.cursor = -1;
          this.list = this.list.filter(Boolean);
          // 重新定位:定时器到点时 current=null 直接 advance
        }
      } else if (op === "reorder" && args.from !== undefined && args.to !== undefined) {
        const [s] = this.list.splice(args.from, 1);
        if (!s) return;
        this.list.splice(args.to, 0, s);
      } else {
        return;
      }

      // cursor 跟随同一首歌
      if (cur) {
        const ni = this.list.indexOf(cur);
        if (ni >= 0 && this.cursor !== -1) this.cursor = ni;
        else if (this.cursor !== -1) this.cursor = ni; // 可能 -1(当前曲被删)
      } else if (this.cursor >= this.list.length) {
        this.cursor = this.list.length - 1;
      }
    });
  }

  async setVolume(v: number) {
    const vol = Math.max(0, Math.min(100, Math.round(v)));
    await this.link.setVolume(vol);
  }
}
