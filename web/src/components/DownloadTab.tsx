import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { api, fmtDuration } from "@/lib/api";
import type { DirsInfo, DlResult, PluginView } from "@/lib/types";
import { usePoll } from "@/lib/usePoll";
import { toast } from "sonner";
import { Download, Loader2, Settings } from "lucide-react";

const SOURCE_NAMES: Record<string, string> = { wy: "网易云", tx: "QQ音乐", kg: "酷狗", url: "直链" };

function PluginSettingsDialog({ plugin, shared, onChanged }: {
  plugin: PluginView;
  shared: Record<string, string>;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [key, setKey] = useState(shared["chksz.apiKey"] ?? "");
  const [relayUrl, setRelayUrl] = useState(String(plugin.extra.relayUrl ?? ""));
  const [token, setToken] = useState("");
  const [sources, setSources] = useState<Record<string, { enabled: boolean; limit: number; qualities: string[] }>>(() =>
    Object.fromEntries(plugin.sources.map((s) => [s.id, { enabled: s.enabled, limit: s.limit ?? 20, qualities: s.qualities ?? s.supportedQualities ?? [] }])),
  );

  const isChksz = plugin.id.startsWith("chksz");
  const isHermes = plugin.id === "hermes-download";

  const save = async () => {
    try {
      if (isChksz) await api.saveShared("chksz.apiKey", key.trim());
      const body: Record<string, unknown> = { sources };
      if (isHermes) {
        body.relayUrl = relayUrl.trim();
        if (token.trim()) body.token = token.trim();
      }
      await api.savePluginSettings(plugin.id, body);
      toast.success("已保存");
      setOpen(false);
      onChanged();
    } catch (e) {
      toast.error(String(e));
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
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
          {isHermes && (
            <>
              <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-2">
                <Label className="text-right text-[11px] text-muted-foreground">Relay 地址</Label>
                <Input value={relayUrl} onChange={(e) => setRelayUrl(e.target.value)} placeholder="http://192.18.7.4:18320"
                  className="h-7 border-border bg-transparent font-mono text-xs" />
              </div>
              <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-2">
                <Label className="text-right text-[11px] text-muted-foreground">Token</Label>
                <Input value={token} onChange={(e) => setToken(e.target.value)}
                  placeholder={plugin.extra.hasToken ? "已配置(留空保持不变)" : "relay 共享密钥"}
                  className="h-7 border-border bg-transparent font-mono text-xs" />
              </div>
              <p className="text-[11px] text-muted-foreground">YouTube 账号 cookies 在 Hermes 侧维护,这里无需配置。</p>
            </>
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

function DownloadDialog({ result, dirs, downloadPlugin, onStarted }: {
  result: DlResult;
  dirs: DirsInfo;
  downloadPlugin?: PluginView;
  onStarted: () => void;
}) {
  const [open, setOpen] = useState(false);
  const srcView = downloadPlugin?.sources.find((s) => s.id === result.source);
  const qualities = (srcView?.qualities?.length ? srcView.qualities : srcView?.supportedQualities) ?? [];
  const [quality, setQuality] = useState("");
  const [dir, setDir] = useState(dirs.defaultDir || dirs.dirs[0] || "");
  const [busy, setBusy] = useState(false);

  const go = () => {
    setBusy(true);
    api.dlDownload({
      source: result.source,
      id: result.id,
      quality: quality || qualities[0],
      dir,
      meta: { title: result.title, artist: result.artist, album: result.album },
    })
      .then(() => { toast.success("下载已开始"); setOpen(false); onStarted(); })
      .catch((e) => toast.error(String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger className="inline-flex h-6 items-center gap-1 rounded border border-border bg-transparent px-1.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground">
        <Download className="h-3 w-3" />下载
      </DialogTrigger>
      <DialogContent className="border-border bg-background sm:max-w-md">
        <DialogHeader><DialogTitle className="text-sm">下载 · {result.title}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">{result.artist} · {result.album || "—"} · {SOURCE_NAMES[result.source]}</p>
          {qualities.length > 0 && (
            <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-2">
              <Label className="text-right text-[11px] text-muted-foreground">音质</Label>
              <Select value={quality || qualities[0]} onValueChange={(v) => v && setQuality(v)}>
                <SelectTrigger className="h-7 border-border bg-transparent text-xs"><SelectValue>{(v: string) => v}</SelectValue></SelectTrigger>
                <SelectContent>
                  {qualities.map((q) => <SelectItem key={q} value={q}>{q}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-2">
            <Label className="text-right text-[11px] text-muted-foreground">保存到</Label>
            <Select value={dir} onValueChange={(v) => v && setDir(v)}>
              <SelectTrigger className="h-7 border-border bg-transparent font-mono text-xs"><SelectValue>{(v: string) => v}</SelectValue></SelectTrigger>
              <SelectContent>
                {dirs.dirs.map((d) => <SelectItem key={d} value={d} className="font-mono text-xs">{d}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="flex justify-end">
            <Button size="sm" disabled={busy} className="h-7 bg-amber-500 text-xs text-zinc-950 hover:bg-amber-400" onClick={go}>
              {busy ? "创建中…" : "开始下载"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function DownloadTab() {
  const { data: pluginData, reload: reloadPlugins } = usePoll(() => api.plugins(), 30000);
  const { data: dirs } = usePoll<DirsInfo>(() => api.dirs(), 60000);
  const { data: jobsData, reload: reloadJobs } = usePoll(() => api.dlJobs(), 3000);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<DlResult[]>([]);
  const [errors, setErrors] = useState<{ source: string; error: string }[]>([]);
  const [searching, setSearching] = useState(false);
  const [directUrl, setDirectUrl] = useState("");
  const [directDir, setDirectDir] = useState("");

  const plugins = pluginData?.plugins ?? [];
  const shared = pluginData?.shared ?? {};
  const downloadPlugin = plugins.find((p) => p.id === "chksz-download");
  const hermesPlugin = plugins.find((p) => p.id === "hermes-download");
  const effDirectDir = directDir || dirs?.defaultDir || dirs?.dirs[0] || "";

  const search = () => {
    if (!q.trim()) return;
    setSearching(true);
    api.dlSearch(q.trim())
      .then((d) => { setResults(d.results); setErrors(d.errors); })
      .catch((e) => toast.error(String(e)))
      .finally(() => setSearching(false));
  };

  const directGo = () => {
    if (!directUrl.trim()) return;
    api.dlDownload({ source: "url", url: directUrl.trim(), dir: effDirectDir })
      .then(() => { toast.success("已交给 Hermes 下载"); setDirectUrl(""); reloadJobs(); })
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
              <PluginSettingsDialog plugin={p} shared={shared} onChanged={reloadPlugins} />
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

      {/* 直接下载(Hermes) */}
      {hermesPlugin && (
        <div className="flex flex-wrap gap-1.5">
          <Input value={directUrl} onChange={(e) => setDirectUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && directGo()}
            placeholder="粘贴链接交给 Hermes 下载(YouTube/B 站等)…"
            className="h-8 min-w-56 flex-1 border-border bg-transparent text-xs" />
          <Select value={effDirectDir} onValueChange={(v) => v && setDirectDir(v)}>
            <SelectTrigger className="h-8 w-48 border-border bg-transparent font-mono text-xs"><SelectValue>{(v: string) => v}</SelectValue></SelectTrigger>
            <SelectContent>
              {(dirs?.dirs ?? []).map((d) => <SelectItem key={d} value={d} className="font-mono text-xs">{d}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button size="sm" variant="outline" className="h-8 border-border bg-transparent text-xs" onClick={directGo}>下载链接</Button>
        </div>
      )}

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

      {results.length > 0 && dirs && (
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
                <th className="w-16 px-2 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {results.map((r, i) => (
                <tr key={`${r.source}-${r.id}-${i}`} className="border-b border-border/60 last:border-0 hover:bg-accent/50">
                  <td className="px-2 py-1.5">
                    {r.cover
                      ? <img src={r.cover} loading="lazy" referrerPolicy="no-referrer" className="h-7 w-7 rounded object-cover" alt="" />
                      : <div className="h-7 w-7 rounded bg-muted" />}
                  </td>
                  <td className="max-w-44 truncate px-2 py-1.5 text-xs text-foreground">{r.title}</td>
                  <td className="max-w-24 truncate px-2 py-1.5 text-xs text-muted-foreground">{r.artist || "—"}</td>
                  <td className="hidden max-w-28 truncate px-2 py-1.5 text-xs text-muted-foreground sm:table-cell">{r.album || "—"}</td>
                  <td className="px-2 py-1.5">
                    <Badge variant="outline" className="border-border text-[10px] text-muted-foreground">{SOURCE_NAMES[r.source] ?? r.source}</Badge>
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono text-xs text-muted-foreground">{r.duration ? fmtDuration(r.duration) : "—"}</td>
                  <td className="px-2 py-1.5">
                    <DownloadDialog result={r} dirs={dirs} downloadPlugin={downloadPlugin} onStarted={reloadJobs} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 任务列表 */}
      {(jobsData?.jobs.length ?? 0) > 0 && (
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">下载任务</Label>
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
