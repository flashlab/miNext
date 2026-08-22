// 语音关键词搜索语义(移植自 miMusic music_search)
import type { LibraryDb, SongRow } from "./db";

export interface SearchSemantics {
  maxResults: number;
  artistSeparators: string[];
  albumSeparators: string[];
}

export function normalizeKeyword(text: string): string {
  return text.trim().replace(/[::,,。!!??\s]+$/u, "").replace(/^[:：,，。!！?？]+/u, "");
}

export function normalizeExact(text: string): string {
  return normalizeKeyword(text).replace(/ /g, "");
}

export function isExactCommand(text: string, keywords: string[]): boolean {
  const normalized = normalizeExact(text);
  if (!normalized) return false;
  return keywords.some((k) => normalizeExact(k) === normalized);
}

export function matchesAnyKeyword(text: string, keywords: string[]): boolean {
  const normalized = normalizeExact(text);
  if (!normalized) return false;
  return keywords.some((k) => {
    const nk = normalizeExact(k);
    return nk && (normalized === nk || normalized.includes(nk));
  });
}

/** 提取"播放本地 xxx"中的 xxx */
export function extractPlayKeyword(text: string, playKeywords: string[]): string | null {
  for (const prefix of playKeywords) {
    const np = normalizeKeyword(prefix);
    if (np && text.startsWith(np)) {
      const kw = normalizeKeyword(text.slice(np.length));
      return kw || null;
    }
  }
  return null;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 语音搜索:
 * - "许嵩" → 全字段模糊,打乱取前 N
 * - "许嵩唱的庐州月"/"许嵩的歌(庐州月)" → artist 限定 + title
 * - "范特西专辑歌曲"/"范特西中的晴天" → album 限定(+title)
 */
export function searchByVoiceKeyword(db: LibraryDb, keyword: string, sem: SearchSemantics): SongRow[] {
  const kw = normalizeKeyword(keyword).toLowerCase();
  if (!kw) return [];

  for (const sep of sem.artistSeparators) {
    const idx = kw.indexOf(sep.toLowerCase());
    if (idx > 0) {
      const artist = kw.slice(0, idx).trim();
      const title = kw.slice(idx + sep.length).trim();
      return shuffle(
        db.searchConstrained({ artist, title: title || undefined, limit: 500 }),
      ).slice(0, sem.maxResults);
    }
  }
  for (const sep of sem.albumSeparators) {
    const idx = kw.indexOf(sep.toLowerCase());
    if (idx > 0) {
      const album = kw.slice(0, idx).trim();
      const title = kw.slice(idx + sep.length).trim();
      return shuffle(
        db.searchConstrained({ album, title: title || undefined, limit: 500 }),
      ).slice(0, sem.maxResults);
    }
  }
  return shuffle(db.search({ q: kw, limit: 500 }).songs).slice(0, sem.maxResults);
}
