import { useMemo, useRef, useState } from "react";
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
import type { DirsInfo, DlResult, PluginView, Speaker } from "@/lib/types";
import { DirTreePicker } from "@/components/DirTreePicker";
import { usePoll } from "@/lib/usePoll";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, ChevronDown, Download, Loader2, Pause, Play, Settings, Trash2 } from "lucide-react";
import coverDefault from "@/assets/cover_default.svg";

const SOURCE_NAMES: Record<string, string> = { kw: "酷我", wy: "网易云", tx: "QQ音乐", kg: "酷狗", bili: "哔哩哔哩", yt: "YouTube", url: "直链" };

/** lx 自定义源管理:当前脚本信息 + 上传替换 + 恢复默认(上传后服务端热重载) */
function LxSourceSection({ plugin, onChanged }: { plugin: PluginView; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const ex = plugin.extra ?? {};
  const loadFailed = ex.loadFailed === true;
  const isOverride = ex.override === true;

  const upload = async (f: File) => {
    if (f.size > 512 * 1024) { toast.error("文件过大(上限 512KB)"); return; }
    setBusy(true);
    try {
      const r = await api.lxSourceUpload(await f.text());
      if (r.loadFailed) toast.error(`加载失败:${r.loadError ?? "未知错误"}`);
      else toast.success(`已切换为「${r.scriptName}」`);
      onChanged();
    } catch (e) { toast.error(String(e)); }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = ""; }
  };
  const reset = async () => {
    setBusy(true);
    try {
      const r = await api.lxSourceReset();
      toast.success(`已恢复「${r.scriptName}」`);
      onChanged();
    } catch (e) { toast.error(String(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-1.5 rounded border border-border p-2">
      <div className="flex items-center gap-2">
        <Label className="text-xs text-muted-foreground">自定义源</Label>
        <span className={`truncate text-[11px] ${loadFailed ? "text-red-400" : ""}`}>
          {String(ex.scriptName ?? "(未加载)")}{loadFailed ? " · 加载失败" : ""}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">{String(ex.scriptMd5 ?? "").slice(0, 8)}</span>
        <span className="ml-auto flex items-center gap-1">
          <input ref={fileRef} type="file" accept=".js" className="hidden"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
          <button type="button" disabled={busy} onClick={() => fileRef.current?.click()}
            className="h-6 whitespace-nowrap rounded border border-border px-2 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50">
            上传 .js 替换
          </button>
          {isOverride && (
            <button type="button" disabled={busy} onClick={() => void reset()}
              className="h-6 whitespace-nowrap rounded border border-border px-2 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50">
              恢复默认
            </button>
          )}
        </span>
      </div>
      {loadFailed && <p className="break-all font-mono text-[10px] text-red-400/80">{String(ex.loadError ?? "")}</p>}
      <p className="text-[10px] text-muted-foreground">
        当前:{isOverride ? "自定义覆盖" : "内置默认"};上传后热重载立即生效,加载失败时 lx 下载不可用。
      </p>
    </div>
  );
}

function PluginSettingsDialog({ plugin, shared, sharedDir, onChanged }: {
  plugin: PluginView;
  shared: Record<string, string>;
  sharedDir: string;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const keyField = plugin.id.startsWith("chksz") ? "chksz.apiKey" : plugin.id.startsWith("ynx") || plugin.id === "lxdownload" ? "ynx.apiKey" : "";
  const [key, setKey] = useState(keyField ? (shared[keyField] ?? "") : "");
  const [sources, setSources] = useState<Record<string, { enabled: boolean; limit: number; qualities: string[] }>>(() =>
    Object.fromEntries(plugin.sources.map((s) => [s.id, { enabled: s.enabled, limit: s.limit ?? 20, qualities: s.qualities ?? s.supportedQualities ?? [] }])),
  );

  const save = async () => {
    try {
      if (keyField) await api.saveShared(keyField, key.trim());
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
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (v && keyField) setKey(shared[keyField] ?? ""); }}>
      <DialogTrigger className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-transparent px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
        <Settings className="h-3 w-3" />设置
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto border-border bg-background sm:max-w-lg">
        <DialogHeader><DialogTitle className="text-sm">{plugin.name} · 设置</DialogTitle></DialogHeader>
        <div className="space-y-4">
          {keyField && (
            <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-2">
              <Label className="text-right text-[11px] text-muted-foreground">API Key(共享)</Label>
              <Input value={key} onChange={(e) => setKey(e.target.value)} placeholder={keyField === "ynx.apiKey" ? "枫雨 api-v2.yuafeng.cn 注册获取" : "chksz_..."}
                className="h-7 border-border bg-transparent font-mono text-xs" />
            </div>
          )}
          {plugin.id === "lxdownload" && <LxSourceSection plugin={plugin} onChanged={onChanged} />}
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

type SortField = "title" | "artist" | "album" | "source" | "duration";
const collator = new Intl.Collator("zh-Hans-CN");

function SortHead({ label, field, sort, order, onSort, align = "left" }: {
  label: string; field: SortField; sort: SortField | ""; order: "asc" | "desc";
  onSort: (f: SortField) => void; align?: "left" | "right";
}) {
  const active = sort === field;
  return (
    <button
      className={`flex w-full items-center gap-0.5 text-xs hover:text-foreground ${align === "right" ? "justify-end" : ""}`}
      onClick={() => onSort(field)}
    >
      {label}
      {active && (order === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
    </button>
  );
}

/** 试听:本地=浏览器 Audio;实例=直链落音箱(先 engine.stop 压掉自动续播定时器,不进入播放列表) */
function usePreview(targetId: string) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playingOnRef = useRef<{ kind: "local" } | { kind: "speaker"; id: string } | null>(null);
  const [previewKey, setPreviewKey] = useState("");
  const [loading, setLoading] = useState("");

  const clearTimer = () => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
  };

  /** 按实际播放位置停掉当前试听 */
  const stopCurrent = async () => {
    clearTimer();
    const on = playingOnRef.current;
    playingOnRef.current = null;
    setPreviewKey("");
    if (on?.kind === "speaker") await api.toolPause(on.id).catch(() => {});
    else if (on?.kind === "local") { audioRef.current?.pause(); audioRef.current = null; }
  };

  const toggle = async (r: DlResult) => {
    const key = `${r.source}:${r.id}`;
    if (previewKey === key) { await stopCurrent(); return; }
    setLoading(key);
    try {
      const d = await api.dlResolve(r.source, r.id, { title: r.title, artist: r.artist, album: r.album });
      await stopCurrent(); // 换曲/换目标:先停上一条(与本地试听语义一致)
      if (!targetId) {
        const a = new Audio(d.fileUrl);
        a.onended = () => { setPreviewKey(""); playingOnRef.current = null; };
        a.onerror = () => { setPreviewKey(""); playingOnRef.current = null; toast.error("试听播放失败"); };
        audioRef.current = a;
        playingOnRef.current = { kind: "local" };
        await a.play();
        setPreviewKey(key);
      } else {
        await api.stop(targetId); // 暂停队列播放并取消自动续播定时器(列表与位置保留)
        await api.toolPlayUrl(targetId, d.fileUrl);
        playingOnRef.current = { kind: "speaker", id: targetId };
        setPreviewKey(key);
        clearTimer();
        if (r.duration && r.duration > 0) {
          // 音箱模式没有 ended 回调,按时长 + 缓冲复位播放中标记
          timerRef.current = setTimeout(() => { playingOnRef.current = null; setPreviewKey(""); }, (r.duration + 2) * 1000);
        }
      }
    } catch (e) {
      toast.error(String(e));
    } finally {
      setLoading("");
    }
  };
  return { previewKey, loading, toggle };
}

export function DownloadTab({ speakers }: { speakers: Speaker[] }) {
  const { data: pluginData, reload: reloadPlugins } = usePoll(() => api.plugins(), 30000);
  const { data: dirs } = usePoll<DirsInfo>(() => api.dirs(), 60000);
  const { data: jobsData, reload: reloadJobs } = usePoll(() => api.dlJobs(), 3000);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<DlResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [sort, setSort] = useState<SortField | "">("");
  const [order, setOrder] = useState<"asc" | "desc">("asc");
  const [previewLocal, setPreviewLocal] = useState<string | null>(null);

  const plugins = pluginData?.plugins ?? [];
  const shared = pluginData?.shared ?? {};
  const downloadPluginFor = (source: string) =>
    plugins.find((p) => p.kind === "download" && p.sources.some((s) => s.id === source && s.enabled));
  const sharedDir = shared["dl.dir"] || dirs?.defaultDir || dirs?.dirs[0] || "";

  // 试听播放方式(共享设置):所选实例被隐藏/删除 → 静默回退本地播放
  const visibleSpeakers = speakers.filter((s) => !s.hidden);
  const savedPreview = shared["dl.preview"] ?? "";
  const previewTarget = previewLocal ?? (visibleSpeakers.some((s) => s.id === savedPreview) ? savedPreview : "");
  const preview = usePreview(previewTarget);

  const setPreviewTarget = (id: string) => {
    setPreviewLocal(id);
    api.saveShared("dl.preview", id)
      .then(() => reloadPlugins())
      .catch((e) => { toast.error(String(e)); setPreviewLocal(null); })
      .finally(() => setPreviewLocal(null));
  };

  const search = () => {
    if (!q.trim()) return;
    setSearching(true);
    api.dlSearch(q.trim())
      .then((d) => {
        setResults(d.results);
        for (const e of d.errors) toast.error(`${SOURCE_NAMES[e.source] ?? e.source}:${e.error}`);
      })
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

  const onSort = (f: SortField) => {
    if (sort === f) setOrder(order === "asc" ? "desc" : "asc");
    else setSort(f);
  };

  const sorted = useMemo(() => {
    if (!sort) return results;
    const dir = order === "asc" ? 1 : -1;
    const val = (r: DlResult): string => {
      if (sort === "source") return SOURCE_NAMES[r.source] ?? r.source;
      if (sort === "duration") return "";
      return r[sort] ?? "";
    };
    return [...results].sort((a, b) => {
      if (sort === "duration") {
        const av = a.duration ?? null, bv = b.duration ?? null;
        if (av === null || bv === null) {
          if (av === null && bv === null) return 0;
          return av === null ? 1 : -1; // 缺失排最后(与升降序无关)
        }
        return dir * (av - bv);
      }
      return dir * collator.compare(val(a), val(b));
    });
  }, [results, sort, order]);

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
              {p.id === "lxdownload" && (
                <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground" title={String(p.extra?.scriptMd5 ?? "")}>
                  {String(p.extra?.scriptName ?? "(未加载)")}
                  {p.extra?.loadFailed ? " · 加载失败" : ""}
                  {p.extra?.override ? " · 自定义" : ""}
                </p>
              )}
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

      {/* 试听播放方式:本地或未隐藏实例;直链播放,不影响播放列表 */}
      <div className="flex flex-wrap items-center gap-1.5">
        <Label className="shrink-0 text-xs text-muted-foreground">试听播放方式</Label>
        <button type="button" onClick={() => setPreviewTarget("")}
          className={`h-7 whitespace-nowrap rounded border px-2 text-xs ${previewTarget === ""
            ? "border-amber-500/60 bg-transparent text-amber-500"
            : "border-border bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground"}`}>
          本地播放
        </button>
        {visibleSpeakers.map((s) => (
          <button key={s.id} type="button" onClick={() => setPreviewTarget(s.id)}
            className={`h-7 whitespace-nowrap rounded border px-2 text-xs ${previewTarget === s.id
              ? "border-amber-500/60 bg-transparent text-amber-500"
              : "border-border bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground"}`}>
            {s.name}
          </button>
        ))}
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

      {results.length > 0 && (
        <div className="overflow-x-auto rounded border border-border">
          <table className="w-full min-w-[560px]">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="w-10 px-2 py-2"></th>
                <th className="px-2 py-2"><SortHead label="歌名" field="title" sort={sort} order={order} onSort={onSort} /></th>
                <th className="w-20 px-2 py-2"></th>
                <th className="px-2 py-2"><SortHead label="歌手" field="artist" sort={sort} order={order} onSort={onSort} /></th>
                <th className="hidden px-2 py-2 sm:table-cell"><SortHead label="专辑" field="album" sort={sort} order={order} onSort={onSort} /></th>
                <th className="px-2 py-2"><SortHead label="源" field="source" sort={sort} order={order} onSort={onSort} /></th>
                <th className="w-14 px-2 py-2"><SortHead label="时长" field="duration" sort={sort} order={order} onSort={onSort} align="right" /></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r, i) => {
                const key = `${r.source}:${r.id}`;
                const isPreviewing = preview.previewKey === key;
                const isLoading = preview.loading === key;
                const qualities = (r.extra?.qualities as string[] | undefined)
                  ?? downloadPluginFor(r.source)?.sources.find((s) => s.id === r.source)?.qualities
                  ?? [];
                return (
                  <tr key={`${key}-${i}`} className="border-b border-border/60 last:border-0 hover:bg-accent/50">
                    <td className="px-2 py-1.5">
                      <button
                        className="group relative block h-7 w-7 overflow-hidden rounded"
                        title={isPreviewing ? "停止试听" : `试听(最低音质)${previewTarget ? " · 音箱" : ""}`}
                        onClick={() => void preview.toggle(r)}
                      >
                        <img
                          src={r.cover || coverDefault}
                          loading="lazy"
                          referrerPolicy="no-referrer"
                          className="h-7 w-7 object-cover"
                          alt=""
                          onError={(e) => {
                            const el = e.currentTarget;
                            if (el.dataset.fb) return;
                            el.dataset.fb = "1";
                            el.src = coverDefault;
                          }}
                        />
                        <span className={`absolute inset-0 flex items-center justify-center bg-black/50 text-white transition-opacity ${
                          isPreviewing || isLoading ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}>
                          {isLoading
                            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            : isPreviewing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                        </span>
                      </button>
                    </td>
                    <td className="max-w-44 truncate px-2 py-1.5 text-xs text-foreground">{r.title}</td>
                    <td className="px-2 py-1.5">
                      <DropdownMenu>
                        <DropdownMenuTrigger className="inline-flex h-6 items-center gap-0.5 rounded border border-border bg-transparent px-1.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground">
                          <Download className="h-3 w-3" /><ChevronDown className="h-3 w-3" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="min-w-28">
                          {(qualities.length ? qualities : [undefined]).map((qu) => (
                            <DropdownMenuItem key={qu ?? "default"} onClick={() => downloadWith(r, qu)}>
                              {qu ?? "默认音质"}
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                    <td className="max-w-24 truncate px-2 py-1.5 text-xs text-muted-foreground">{r.artist || "—"}</td>
                    <td className="hidden max-w-28 truncate px-2 py-1.5 text-xs text-muted-foreground sm:table-cell">{r.album || "—"}</td>
                    <td className="px-2 py-1.5">
                      <Badge variant="outline" className="border-border text-[10px] text-muted-foreground">{SOURCE_NAMES[r.source] ?? r.source}</Badge>
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono text-xs text-muted-foreground">{r.duration ? fmtDuration(r.duration) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* 任务列表:右端清理已结束任务 */}
      {(jobsData?.jobs.length ?? 0) > 0 && (
        <div className="space-y-1">
          <div className="flex items-center gap-1.5">
            <Label className="text-xs text-muted-foreground">下载任务 · 保存到 <span className="font-mono">{sharedDir}</span></Label>
            <button
              type="button"
              title="清理已结束任务"
              className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => {
                api.dlClearJobs()
                  .then((r) => { toast.success(r.removed > 0 ? `已清理 ${r.removed} 条已结束任务` : "没有可清理的任务"); reloadJobs(); })
                  .catch((e) => toast.error(String(e)));
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
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
