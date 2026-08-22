import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { api, fmtTimeAgo } from "@/lib/api";
import type { GlobalSettings, Speaker, SpeakerCommands } from "@/lib/types";
import { toast } from "sonner";
import { EyeOff, Plus, Settings, SlidersHorizontal } from "lucide-react";

const COMMAND_FIELDS: { key: keyof SpeakerCommands; label: string; def: string }[] = [
  { key: "playKeywords", label: "播放关键词", def: "播放本地" },
  { key: "stopKeywords", label: "停止关键词", def: "停止播放,暂停播放,停止,暂停,闭嘴,别放了,不要放了,关机" },
  { key: "previousKeywords", label: "上一首", def: "上一首,上一曲" },
  { key: "nextKeywords", label: "下一首", def: "下一首,下一曲" },
  { key: "refreshKeywords", label: "刷新曲库", def: "刷新曲库" },
  { key: "randomPlayKeywords", label: "随机播放", def: "随便听听" },
  { key: "continueKeywords", label: "继续播放", def: "继续播放,继续" },
  { key: "deleteKeywords", label: "删除当前(回收站)", def: "删除当前,删除音乐" },
  { key: "undoDeleteKeywords", label: "撤销删除", def: "撤销删除,撤销" },
  { key: "interruptWhitelistKeywords", label: "打断白名单(音量类)", def: "音量,声音,大点声,小点声,调大音量,调小音量,静音,取消静音" },
];

const EXT_CANDIDATES = ["mp3", "aac", "ogg", "m4a", "flac", "ape", "wav"];

function parseCsv(s: string): string[] {
  return s.split(/[,,]/).map((x) => x.trim()).filter(Boolean);
}

/** 全局设置:关键词 + 音频后缀 + 语音搜索语义(实例无关) */
function GlobalSettingsDialog() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<GlobalSettings | null>(null);
  const [cmdForm, setCmdForm] = useState<Record<string, string>>({});
  const [exts, setExts] = useState<Set<string>>(new Set());
  const [maxResults, setMaxResults] = useState("20");
  const [artistSeps, setArtistSeps] = useState("");
  const [albumSeps, setAlbumSeps] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    api.globalSettings()
      .then((g) => {
        setData(g);
        setCmdForm(Object.fromEntries(COMMAND_FIELDS.map((f) => [f.key, (g.commands[f.key] ?? []).join(",")])));
        setExts(new Set(g.audioExtensions.map((e) => e.replace(/^\./, ""))));
        setMaxResults(String(g.search.maxResults));
        setArtistSeps(g.search.artistSeparators.join(","));
        setAlbumSeps(g.search.albumSeparators.join(","));
      })
      .catch((e) => toast.error(String(e)));
  }, [open]);

  const save = () => {
    const mr = parseInt(maxResults);
    if (!mr || mr < 1 || mr > 500) return toast.error("语音列表上限须为 1-500");
    if (!exts.size) return toast.error("至少保留一种音频后缀");
    const commands: SpeakerCommands = {};
    for (const f of COMMAND_FIELDS) {
      const v = parseCsv(cmdForm[f.key] ?? "");
      if (v.length) (commands as Record<string, string[]>)[f.key] = v;
    }
    setBusy(true);
    api.saveGlobalSettings({
      commands,
      audioExtensions: [...exts],
      search: { maxResults: mr, artistSeparators: parseCsv(artistSeps), albumSeparators: parseCsv(albumSeps) },
    })
      .then(() => { toast.success("全局设置已保存并热生效(后缀变更会自动重建索引)"); setOpen(false); })
      .catch((e) => toast.error(String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-transparent px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
        <SlidersHorizontal className="h-3 w-3" />设置
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto border-border bg-background sm:max-w-lg">
        <DialogHeader><DialogTitle className="text-sm">全局设置</DialogTitle></DialogHeader>
        {!data ? <p className="py-6 text-center text-xs text-muted-foreground">加载中…</p> : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">语音命令关键词(全局,对所有实例生效)</Label>
              <div className="grid gap-2">
                {COMMAND_FIELDS.map((f) => (
                  <div key={f.key} className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-2">
                    <Label className="text-right text-[11px] text-muted-foreground">{f.label}</Label>
                    <Input
                      value={cmdForm[f.key] ?? ""}
                      placeholder={f.def}
                      className="h-7 border-border bg-transparent text-xs"
                      onChange={(e) => setCmdForm({ ...cmdForm, [f.key]: e.target.value })}
                    />
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">逗号分隔;留空则使用系统默认。</p>
            </div>
            <Separator className="bg-border" />
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">音频后缀(勾选纳入曲库;变更后自动重建索引)</Label>
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                {EXT_CANDIDATES.map((e) => (
                  <label key={e} className="flex items-center gap-1.5 text-xs text-foreground">
                    <Checkbox
                      checked={exts.has(e)}
                      onCheckedChange={(v) => {
                        const next = new Set(exts);
                        if (v === true) next.add(e); else next.delete(e);
                        setExts(next);
                      }}
                    />
                    .{e}
                  </label>
                ))}
              </div>
            </div>
            <Separator className="bg-border" />
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">语音搜索</Label>
              <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-2">
                <Label className="text-right text-[11px] text-muted-foreground">播放列表上限</Label>
                <Input value={maxResults} onChange={(e) => setMaxResults(e.target.value)}
                  className="h-7 w-24 border-border bg-transparent font-mono text-xs" />
              </div>
              <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-2">
                <Label className="text-right text-[11px] text-muted-foreground">歌手触发词</Label>
                <Input value={artistSeps} onChange={(e) => setArtistSeps(e.target.value)} placeholder="唱的,的歌"
                  className="h-7 border-border bg-transparent text-xs" />
              </div>
              <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-2">
                <Label className="text-right text-[11px] text-muted-foreground">专辑触发词</Label>
                <Input value={albumSeps} onChange={(e) => setAlbumSeps(e.target.value)} placeholder="专辑,中的"
                  className="h-7 border-border bg-transparent text-xs" />
              </div>
              <p className="text-[11px] text-muted-foreground">如「周杰伦唱的晴天」按歌手限定;「叶惠美专辑晴天」按专辑限定。</p>
            </div>
            <div className="flex justify-end pt-1">
              <Button size="sm" disabled={busy} className="h-7 bg-amber-500 text-xs text-zinc-950 hover:bg-amber-400" onClick={save}>
                {busy ? "保存中…" : "保存"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** 状态徽章:离线/空闲/播放中/已暂停 四态合一 */
export function StatusBadge({ s }: { s: Speaker }) {
  if (!s.online) {
    return <Badge variant="outline" className="border-border text-muted-foreground">离线</Badge>;
  }
  if (s.playing === "Playing") {
    return <Badge variant="outline" className="border-amber-500/60 text-amber-500">播放中</Badge>;
  }
  if (s.playing === "Paused") {
    return <Badge variant="outline" className="border-amber-500/40 text-amber-500/70">已暂停</Badge>;
  }
  return <Badge variant="outline" className="border-border text-muted-foreground">空闲</Badge>;
}

export function fmtIp(ip: string): string {
  return ip.replace(/^::ffff:/, "");
}

function InstallHint({ port, token }: { port: string; token: string }) {
  const host = window.location.hostname;
  const wsUrl = `ws://${host}:${port || "<端口>"}${token ? `/ws/${token}` : ""}`;
  const cmds = [
    "mkdir -p /data/open-xiaoai",
    `echo '${wsUrl}' > /data/open-xiaoai/server.txt`,
    "curl -sSfL https://gitee.com/idootop/artifacts/releases/download/open-xiaoai-client/init.sh | sh",
    "curl -L -o /data/init.sh https://gitee.com/idootop/artifacts/releases/download/open-xiaoai-client/boot.sh && reboot",
  ].join("\n");
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">音箱端安装/接入命令(SSH 到刷机音箱执行)</Label>
      <pre className="max-w-full overflow-x-auto rounded border border-border bg-muted/50 p-2 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap text-muted-foreground">{cmds}</pre>
      <p className="text-[11px] text-muted-foreground">
        最后一行为开机自启(可选)。远程公网接入需先在设置里配置 token,并用 wss 反代。
      </p>
    </div>
  );
}

function SpeakerSettingsDialog({ speaker, onChanged }: { speaker: Speaker; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(speaker.name);
  const [port, setPort] = useState(String(speaker.wsPort));
  const [token, setToken] = useState(speaker.token);
  const [hidden, setHidden] = useState(speaker.hidden);

  const save = () => {
    const wsPort = parseInt(port);
    if (!wsPort) return toast.error("端口非法");
    api.updateSpeaker(speaker.id, { name, wsPort, hidden, token })
      .then(() => { toast.success("已保存"); setOpen(false); onChanged(); })
      .catch((e) => toast.error(String(e)));
  };

  const del = () => {
    if (!confirm(`确认删除实例「${speaker.name}」?${speaker.online ? "音箱在线,删除后它将持续重试连接直至重新添加。" : ""}`)) return;
    api.deleteSpeaker(speaker.id)
      .then(() => { toast.success("实例已删除"); setOpen(false); onChanged(); })
      .catch((e) => toast.error(String(e)));
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-transparent px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
        <Settings className="h-3 w-3" />设置
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto border-border bg-background sm:max-w-lg">
        <DialogHeader><DialogTitle className="text-sm">实例设置 · {speaker.name}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-2">
            <Label className="text-right text-[11px] text-muted-foreground">昵称</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} className="h-7 border-border bg-transparent text-xs" />
          </div>
          <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-2">
            <Label className="text-right text-[11px] text-muted-foreground">WS 端口</Label>
            <Input value={port} onChange={(e) => setPort(e.target.value)} className="h-7 border-border bg-transparent font-mono text-xs" />
          </div>
          <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-2">
            <Label className="text-right text-[11px] text-muted-foreground">接入 token</Label>
            <Input value={token} onChange={(e) => setToken(e.target.value)} placeholder="留空 = 仅 LAN 免鉴权"
              className="h-7 border-border bg-transparent font-mono text-xs" />
          </div>
          <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-2">
            <Label className="text-right text-[11px] text-muted-foreground">隐藏实例</Label>
            <div className="flex items-center gap-2">
              <Checkbox checked={hidden} onCheckedChange={(v) => setHidden(v === true)} />
              <span className="text-[11px] text-muted-foreground">从播放/音乐/工具页隐藏此音箱</span>
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">
            改端口/token 即时重绑;音箱侧 server.txt 需指向 {`ws://主机:${port || speaker.wsPort}${token ? `/ws/${token}` : ""}`}。
            语音命令关键词已移至页面顶部「设置」(全局)。
          </p>
          <div className="flex items-center justify-between pt-1">
            <Button size="sm" variant="outline" className="h-7 border-red-500/50 bg-transparent text-xs text-red-500 hover:bg-red-500/10" onClick={del}>
              删除此实例
            </Button>
            <Button size="sm" className="h-7 bg-amber-500 text-xs text-zinc-950 hover:bg-amber-400" onClick={save}>保存</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AddSpeakerDialog({ onChanged }: { onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [port, setPort] = useState("");
  const [name, setName] = useState("");
  const [token, setToken] = useState("");

  const add = () => {
    const wsPort = parseInt(port);
    if (!wsPort) return toast.error("请填 WS 端口");
    api.addSpeaker({ wsPort, name: name.trim() || undefined, token: token.trim() || undefined })
      .then(() => { toast.success("实例已添加,端口已监听"); setOpen(false); onChanged(); })
      .catch((e) => toast.error(String(e)));
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-transparent px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
        <Plus className="h-3 w-3" />添加实例
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto border-border bg-background sm:max-w-lg">
        <DialogHeader><DialogTitle className="text-sm">添加音箱实例</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-2">
            <Label className="text-right text-[11px] text-muted-foreground">WS 端口 *</Label>
            <Input value={port} onChange={(e) => setPort(e.target.value)} placeholder="如 4400" className="h-7 border-border bg-transparent font-mono text-xs" />
          </div>
          <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-2">
            <Label className="text-right text-[11px] text-muted-foreground">昵称</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="音箱-<端口>" className="h-7 border-border bg-transparent text-xs" />
          </div>
          <div className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-2">
            <Label className="text-right text-[11px] text-muted-foreground">接入 token</Label>
            <Input value={token} onChange={(e) => setToken(e.target.value)} placeholder="公网接入时填写" className="h-7 border-border bg-transparent font-mono text-xs" />
          </div>
          <InstallHint port={port} token={token.trim()} />
          <div className="flex justify-end">
            <Button size="sm" className="h-7 bg-amber-500 text-xs text-zinc-950 hover:bg-amber-400" onClick={add}>添加并监听</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SpeakerCard({ s, onChanged }: { s: Speaker; onChanged: () => void }) {
  return (
    <Card className="border-border bg-card shadow-none">
      <CardHeader className="flex flex-row items-center justify-between py-3">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          {s.name}
          <StatusBadge s={s} />
          {s.hidden && (
            <Badge variant="outline" className="border-border text-muted-foreground">
              <EyeOff className="mr-0.5 h-3 w-3" />已隐藏
            </Badge>
          )}
        </CardTitle>
        <div className="flex gap-1.5">
          <SpeakerSettingsDialog speaker={s} onChanged={onChanged} />
          <Button size="sm" variant="outline" disabled={!s.online}
            title={s.online ? "断开当前连接,音箱将在 1s 后自动重连" : "音箱离线时会自行重试,无需操作"}
            className="h-7 border-border bg-transparent text-xs text-muted-foreground hover:bg-accent"
            onClick={() => api.reconnect(s.id).then(() => toast.success("已断开,音箱将自动重连")).catch((e) => toast.error(String(e))).finally(onChanged)}>
            重连
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-2 py-2 text-xs text-muted-foreground">
        <div className="flex justify-between"><span>WS 端口</span><span className="font-mono text-foreground">{s.wsPort}</span></div>
        <div className="flex justify-between"><span>连接地址</span><span className="font-mono text-foreground">{s.lastIp ? fmtIp(s.lastIp) : "—"}</span></div>
        <Separator className="bg-border" />
        <div className="flex justify-between"><span>型号</span><span className="font-mono text-foreground">{s.device.model || "—"}</span></div>
        <div className="flex justify-between"><span>序列号</span><span className="font-mono text-foreground">{s.device.sn || "—"}</span></div>
        <Separator className="bg-border" />
        <div className="flex justify-between"><span>最近事件</span><span className="text-foreground">{fmtTimeAgo(s.lastEventAt)}</span></div>
        <div className="flex justify-between">
          <span>当前播放</span>
          <span className="max-w-[60%] truncate text-foreground">
            {s.player.current ? `${s.player.current.title} · ${s.player.current.artist}` : "—"}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

export function SpeakersTab({ speakers, onChanged }: { speakers: Speaker[]; onChanged: () => void }) {
  const visible = speakers.filter((s) => !s.hidden);
  const hiddenOnes = speakers.filter((s) => s.hidden);
  return (
    <div className="space-y-3">
      <div className="flex justify-end gap-1.5">
        <GlobalSettingsDialog />
        <AddSpeakerDialog onChanged={onChanged} />
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {visible.map((s) => <SpeakerCard key={s.id} s={s} onChanged={onChanged} />)}
      </div>
      {hiddenOnes.length > 0 && (
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
            已隐藏实例({hiddenOnes.length})
          </summary>
          <div className="mt-2 grid gap-3 opacity-70 md:grid-cols-2">
            {hiddenOnes.map((s) => <SpeakerCard key={s.id} s={s} onChanged={onChanged} />)}
          </div>
        </details>
      )}
    </div>
  );
}
