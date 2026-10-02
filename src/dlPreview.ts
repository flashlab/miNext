// 试听(preview)共享态:服务端唯一记录"音箱正在试听哪首",跨标签页/跨设备可见可停。
// 只记落音箱的试听——本地播放=浏览器 Audio,天然属单标签页。
// 写入:http 层 POST /api/dl/preview;清理:任意 pausePlayback(link 钩子)、显式 DELETE、GET 侧惰性过期。
export interface DlPreviewState {
  key: string; // `${source}:${id}`
  source: string;
  id: string;
  instance: string; // 音箱实例 id
  instanceName: string;
  title?: string;
  artist?: string;
  startedAt: number;
  untilTs: number; // 0=时长未知,保持到停止;>0 到点后惰性过期
}

import { emitPreview } from "./sync";

let state: DlPreviewState | null = null;

export function getPreview(): DlPreviewState | null {
  if (state && state.untilTs > 0 && Date.now() > state.untilTs) state = null;
  return state;
}

export function setPreview(p: {
  key: string; source: string; id: string; instance: string; instanceName: string;
  title?: string; artist?: string; duration?: number;
}): DlPreviewState {
  const now = Date.now();
  state = {
    key: p.key, source: p.source, id: p.id,
    instance: p.instance, instanceName: p.instanceName,
    title: p.title, artist: p.artist,
    startedAt: now,
    untilTs: p.duration && p.duration > 0 ? now + (p.duration + 2) * 1000 : 0,
  };
  emitPreview(state);
  return state;
}

/** 清态;传 instance 时只清该实例的(别的实例的暂停不动它) */
export function clearPreview(instance?: string): DlPreviewState | null {
  const cur = state;
  if (!cur) return null;
  if (instance && cur.instance !== instance) return null;
  state = null;
  emitPreview(null);
  return cur;
}
