// Hermes 下载插件:链接发给 Hermes 本机的 ytdlp-relay,返回临时文件链接
import type { DownloadPlugin, PluginCtx, ResolvedAudio } from "./types";

interface RelayResp {
  ok: boolean;
  file?: string; // /files/<name>
  title?: string;
  uploader?: string;
  duration?: number;
  error?: string;
}

export const hermesDownload: DownloadPlugin = {
  kind: "download",
  id: "hermes-download",
  name: "Hermes (yt-dlp)",
  sources: [{ id: "url", name: "直链(YouTube 等)" }],
  async resolve({ url }, ctx): Promise<ResolvedAudio> {
    if (!url) throw new Error("Hermes 下载需要链接");
    const s = ctx.getSetting("hermes-download") as { relayUrl?: string; token?: string };
    const base = (s.relayUrl || "").replace(/\/+$/, "");
    if (!base) throw new Error("未配置 Hermes relay 地址(插件设置中填写)");
    const r = await fetch(`${base}/api/download`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(s.token ? { authorization: `Bearer ${s.token}` } : {}),
      },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(200_000),
    });
    const j = (await r.json().catch(() => ({}))) as RelayResp;
    if (!r.ok || !j.ok || !j.file) {
      throw new Error(j.error || `relay 错误 ${r.status}`);
    }
    const ext = (j.file.split(".").pop() || "m4a").toLowerCase();
    return {
      fileUrl: `${base}${j.file}`,
      ext,
      title: j.title || "",
      artist: j.uploader || "",
      album: "",
    };
  },
};
