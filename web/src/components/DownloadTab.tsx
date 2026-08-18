import { useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { api, fmtDuration } from "@/lib/api";
import type { DirsInfo, DlResult, PluginView } from "@/lib/types";
import { DirTreePicker } from "@/components/DirTreePicker";
import { usePoll } from "@/lib/usePoll";
import { toast } from "sonner";
import { ChevronDown, Download, Loader2, Pause, Play, Settings } from "lucide-react";

const SOURCE_NAMES: Record<string, string> = { wy: "网易云", tx: "QQ音乐", kg: "酷狗", url: "直链" };

function PluginSettingsDialog({ plugin, shared, sharedDir, onChanged }: {
  plugin: PluginView;
  shared: Record<string, string>;
  sharedDir: string;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState(shared["chksz.apiKey"] ?? "");
  const [sources, setSources] = useState<Record<string, { enabled: boolean; limit: number; qualities: string[] }>>(() =>
    Object.fromEntries(plugin.sources.map((s) => [s.id, { enabled: s.enabled, limit: s.limit ?? 20, qualities: s.qualities ?? s.supportedQualities ?? [] }])),
  );

  const isChksz = plugin.id.startsWith("chksz");

  const save = async () => {
    try {
      if (isChksz) await api.saveShared("chksz.apiKey", key.trim());
      const body: Record<string, unknown> = { sources };
      await api.savePluginSettings(plugin.id, body);
      toast.success("已保存");
      setOpen(false);
      onChanged();
    } catch (e) {
      toast.error(String(e));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (v) setKey(shared["chksz.apiKey"] ?? ""); }}>
      <DialogTrigger className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-transparent px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
        <Settings className="h-3 w-3" />设置
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto border-border bg-background sm:max-w-lg">
        <DialogHeader><DialogTitle className="text-sm">{plugin.name} · 设置</DialogTitle></DialogHeader>
        <div className="space-y-4">
          {isChksz && (
            <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-2">
              <Label className="text-right text-[11px] text-muted-foreground">API Key(共享)</Label>
              <Input value={key} onChange={(e) => setKey(e.target.value)} placeholder="chksz_..."
                className="h-7 border-border bg-transparent font-mono text-xs" />
            </div>
          )}
          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">音源</Label>
            {plugin.sources.map((s) => (
              <div key={s.id} className="space-y-1.5 rounded border border-border p-2">
                <div className="flex items-center gap-2">
                  <Checkbox
                    checked={sources[s.id]?.enabled ?? false}
                    onCheckedChange={(v) => setSources({ ...sources, [s.id]: { ...sources[s.id], enabled: v === true } })}
                  />
                  <span className="text-xs">{s.name}</span>
                  <span className="font-mono text-[10px] text-muted-foreground">{s.id}</span>
                </div>
                {plugin.kind === "search" && (
                  <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-2">
                    <Label className="text-right text-[11px] text-muted-foreground">最大返回</Label>
                    <Input type="number" value={sources[s.id]?.limit ?? 20}
                      onChange={(e) => setSources({ ...sources, [s.id]: { ...sources[s.id], limit: parseInt(e.target.value) || 20 } })}
                      className="h-7 w-24 border-border bg-transparent font-mono text-xs" />
                  </div>
                )}
                {plugin.kind === "download" && s.supportedQualities && (
                  <div className="flex flex-wrap items-center gap-2 pl-6">
                    {s.supportedQualities.map((q) => (
                      <label key={q} className="flex items-center gap-1 text-[11px] text-muted-foreground">
                        <Checkbox
                          checked={(sources[s.id]?.qualities ?? []).includes(q)}
                          onCheckedChange={(v) => {
                            const cur = sources[s.id]?.qualities ?? [];
                            const next = v === true ? [...cur, q] : cur.filter((x) => x !== q);
                            setSources({ ...sources, [s.id]: { ...sources[s.id], qualities: next } });
                          }}
                        />
                        {q}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            ))}
            <p className="text-[11px] text-muted-foreground">同一音源只能在一种搜索插件和一种下载插件中启用,冲突会被拒绝。</p>
          </div>
          <div className="flex justify-end">
            <Button size="sm" className="h-7 bg-amber-500 text-xs text-zinc-950 hover:bg-amber-400" onClick={save}>保存</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** 试听状态:全局单 Audio 实例 */
function usePreview() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [previewKey, setPreviewKey] = useState("");
  const [loading, setLoading] = useState("");

  const toggle = async (r: DlResult) => {
    const key = `${r.source}:${r.id}`;
    if (previewKey === key) {
      audioRef.current?.pause();
      audioRef.current = null;
      setPreviewKey("");
      return;
    }
    setLoading(key);
    try {
      const d = await api.dlResolve(r.source, r.id);
      audioRef.current?.pause();
      const a = new Audio(d.fileUrl);
      a.onended = () => setPreviewKey("");
      a.onerror = () => { setPreviewKey(""); toast.error("试听播放失败"); };
      audioRef.current = a;
      await a.play();
      setPreviewKey(key);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setLoading("");
    }
  };
  return { previewKey, loading, toggle };
}

export function DownloadTab() {
  const { data: pluginData, reload: reloadPlugins } = usePoll(() => api.plugins(), 30000);
  const { data: dirs } = usePoll<DirsInfo>(() => api.dirs(), 60000);
  const { data: jobsData, reload: reloadJobs } = usePoll(() => api.dlJobs(), 3000);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<DlResult[]>([]);
  const [errors, setErrors] = useState<{ source: string; error: string }[]>([]);
  const [searching, setSearching] = useState(false);
  const preview = usePreview();

  const plugins = pluginData?.plugins ?? [];
  const shared = pluginData?.shared ?? {};
  const downloadPlugin = plugins.find((p) => p.id === "chksz-download");
  const sharedDir = shared["dl.dir"] || dirs?.defaultDir || dirs?.dirs[0] || "";

  const search = () => {
    if (!q.trim()) return;
    setSearching(true);
    api.dlSearch(q.trim())
      .then((d) => { setResults(d.results); setErrors(d.errors); })
      .catch((e) => toast.error(String(e)))
      .finally(() => setSearching(false));
  };

  const downloadWith = (r: DlResult, quality?: string) => {
    api.dlDownload({
      source: r.source, id: r.id, quality, dir: sharedDir,
      meta: { title: r.title, artist: r.artist, album: r.album },
    })
      .then(() => { toast.success(`已开始下载(${quality || "默认音质"})`); reloadJobs(); })
      .catch((e) => toast.error(String(e)));
  };

  return (
    <div className="space-y-4">
      {/* 插件卡 */}
      <div className="grid gap-2 sm:grid-cols-3">
        {plugins.map((p) => (
          <Card key={p.id} className="border-border bg-card shadow-none">
            <CardHeader className="flex flex-row items-center justify-between py-2">
              <CardTitle className="text-xs font-medium">{p.name}</CardTitle>
              <PluginSettingsDialog plugin={p} shared={shared} sharedDir={sharedDir} onChanged={reloadPlugins} />
            </CardHeader>
            <CardContent className="py-1.5">
              <div className="flex flex-wrap gap-1">
                {p.sources.map((s) => (
                  <Badge key={s.id} variant="outline" className={s.enabled ? "border-amber-500/60 text-amber-500" : "border-border text-muted-foreground"}>
                    {s.name}
                  </Badge>
                ))}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* 共享下载目录:直观展示 + 树选 */}
      <div className="flex items-center gap-1.5">
        <Label className="shrink-0 text-xs text-muted-foreground">下载目录(共享)</Label>
        <div className="min-w-0 flex-1 truncate rounded border border-border bg-muted/40 px-2 py-1 font-mono text-[11px] text-muted-foreground">
          {sharedDir || "未设置"}
        </div>
        <DirTreePicker value={sharedDir} onSelect={(p) => {
          api.saveShared("dl.dir", p).then(() => { toast.success("下载目录已更新"); reloadPlugins(); }).catch((e) => toast.error(String(e)));
        }} />
      </div>
      {/* 搜索 */}
      <div className="flex flex-wrap gap-1.5">
        <Input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && search()}
          placeholder="搜索第三方音源(歌名 / 歌手)…"
          className="h-8 min-w-48 flex-1 border-border bg-transparent text-xs" />
        <Button size="sm" variant="outline" className="h-8 border-border bg-transparent text-xs" disabled={searching} onClick={search}>
          {searching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "搜索"}
        </Button>
      </div>

      {errors.length > 0 && (
        <div className="space-y-0.5">
          {errors.map((e, i) => (
            <p key={i} className="text-[11px] text-red-500">{SOURCE_NAMES[e.source] ?? e.source}: {e.error}</p>
          ))}
        </div>
      )}

      {results.length > 0 && (
        <div className="overflow-x-auto rounded border border-border">
          <table className="w-full min-w-[560px]">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="w-10 px-2 py-2"></th>
                <th className="px-2 py-2">歌名</th>
                <th className="px-2 py-2">歌手</th>
                <th className="hidden px-2 py-2 sm:table-cell">专辑</th>
                <th className="px-2 py-2">源</th>
                <th className="w-14 px-2 py-2 text-right">时长</th>
                <th className="w-20 px-2 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {results.map((r, i) => {
                const key = `${r.source}:${r.id}`;
                const isPreviewing = preview.previewKey === key;
                const isLoading = preview.loading === key;
                const qualities = downloadPlugin?.sources.find((s) => s.id === r.source)?.qualities ?? [];
                return (
                  <tr key={`${key}-${i}`} className="border-b border-border/60 last:border-0 hover:bg-accent/50">
                    <td className="px-2 py-1.5">
                      <button
                        className="group relative block h-7 w-7 overflow-hidden rounded"
                        title={isPreviewing ? "停止试听" : "试听(最低音质)"}
                        onClick={() => preview.toggle(r)}
                      >
                        {r.cover
                          ? <img src={r.cover} loading="lazy" referrerPolicy="no-referrer" className="h-7 w-7 object-cover" alt="" />
                          : <div className="h-7 w-7 bg-muted" />}
                        <span className={`absolute inset-0 flex items-center justify-center bg-black/50 text-white transition-opacity ${
                          isPreviewing || isLoading ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}>
                          {isLoading
                            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            : isPreviewing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                        </span>
                      </button>
                    </td>
                    <td className="max-w-44 truncate px-2 py-1.5 text-xs text-foreground">{r.title}</td>
                    <td className="max-w-24 truncate px-2 py-1.5 text-xs text-muted-foreground">{r.artist || "—"}</td>
                    <td className="hidden max-w-28 truncate px-2 py-1.5 text-xs text-muted-foreground sm:table-cell">{r.album || "—"}</td>
                    <td className="px-2 py-1.5">
                      <Badge variant="outline" className="border-border text-[10px] text-muted-foreground">{SOURCE_NAMES[r.source] ?? r.source}</Badge>
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono text-xs text-muted-foreground">{r.duration ? fmtDuration(r.duration) : "—"}</td>
                    <td className="px-2 py-1.5">
                      <DropdownMenu>
                        <DropdownMenuTrigger className="inline-flex h-6 items-center gap-0.5 rounded border border-border bg-transparent px-1.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground">
                          <Download className="h-3 w-3" /><ChevronDown className="h-3 w-3" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="min-w-28">
                          {(qualities.length ? qualities : [undefined]).map((qu) => (
                            <DropdownMenuItem key={qu ?? "default"} onClick={() => downloadWith(r, qu)}>
                              {qu ?? "默认音质"}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* 任务列表 */}
      {(jobsData?.jobs.length ?? 0) > 0 && (
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">下载任务 · 保存到 <span className="font-mono">{sharedDir}</span></Label>
          <div className="rounded border border-border">
            {jobsData!.jobs.map((j) => (
              <div key={j.id} className="flex items-center gap-2 border-b border-border/60 px-2 py-1.5 text-xs last:border-0">
                {j.status === "running" && <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-500" />}
                {j.status === "done" && <span className="text-amber-500">✓</span>}
                {j.status === "failed" && <span className="text-red-500">✗</span>}
                <span className="min-w-0 flex-1 truncate text-foreground">{j.label}</span>
                {j.error && <span className="max-w-[40%] truncate text-[11px] text-red-500" title={j.error}>{j.error}</span>}
                {j.savedPath && <span className="max-w-[40%] truncate font-mono text-[11px] text-muted-foreground" title={j.savedPath}>{j.savedPath}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
