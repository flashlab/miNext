import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { api, fmtTimeAgo } from "@/lib/api";
import type { Speaker, SpeakerCommands } from "@/lib/types";
import { toast } from "sonner";
import { Plus, Settings } from "lucide-react";

const COMMAND_FIELDS: { key: keyof SpeakerCommands; label: string; def: string }[] = [
  { key: "playKeywords", label: "播放关键词", def: "播放本地" },
  { key: "stopKeywords", label: "停止关键词", def: "停止播放,暂停播放,停止,暂停,闭嘴,别放了,不要放了,关机" },
  { key: "previousKeywords", label: "上一首", def: "上一首,上一曲" },
  { key: "nextKeywords", label: "下一首", def: "下一首,下一曲" },
  { key: "refreshKeywords", label: "刷新曲库", def: "刷新曲库" },
  { key: "randomPlayKeywords", label: "随机播放", def: "随便听听" },
  { key: "continueKeywords", label: "继续播放", def: "继续播放,继续" },
  { key: "interruptWhitelistKeywords", label: "打断白名单(音量类)", def: "音量,声音,大点声,小点声,调大音量,调小音量,静音,取消静音" },
];

function commandsToText(c: SpeakerCommands, key: keyof SpeakerCommands): string {
  return (c[key] ?? []).join(",");
}

function parseCommands(form: Record<string, string>): SpeakerCommands {
  const out: SpeakerCommands = {};
  for (const f of COMMAND_FIELDS) {
    const v = (form[f.key] ?? "").split(/[,,]/).map((s) => s.trim()).filter(Boolean);
    if (v.length) (out as Record<string, string[]>)[f.key] = v;
  }
  return out;
}

function CommandsEditor({ initial, onChange }: { initial: SpeakerCommands; onChange: (c: SpeakerCommands) => void }) {
  const [form, setForm] = useState<Record<string, string>>(() =>
    Object.fromEntries(COMMAND_FIELDS.map((f) => [f.key, commandsToText(initial, f.key)])),
  );
  return (
    <div className="grid gap-2">
      {COMMAND_FIELDS.map((f) => (
        <div key={f.key} className="grid grid-cols-[7rem_1fr] items-center gap-2">
          <Label className="text-right text-[11px] text-muted-foreground">{f.label}</Label>
          <Input
            value={form[f.key] ?? ""}
            placeholder={f.def}
            className="h-7 border-border bg-transparent text-xs"
            onChange={(e) => {
              const next = { ...form, [f.key]: e.target.value };
              setForm(next);
              onChange(parseCommands(next));
            }}
          />
        </div>
      ))}
      <p className="text-[11px] text-muted-foreground">逗号分隔;留空则使用系统默认。</p>
    </div>
  );
}

function SpeakerSettingsDialog({ speaker, onChanged }: { speaker: Speaker; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(speaker.name);
  const [port, setPort] = useState(String(speaker.wsPort));
  const [commands, setCommands] = useState<SpeakerCommands>(speaker.commands);

  const save = () => {
    const wsPort = parseInt(port);
    if (!wsPort) return toast.error("端口非法");
    api.updateSpeaker(speaker.id, { name, wsPort, commands })
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
          <div className="grid grid-cols-[7rem_1fr] items-center gap-2">
            <Label className="text-right text-[11px] text-muted-foreground">昵称</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} className="h-7 border-border bg-transparent text-xs" />
          </div>
          <div className="grid grid-cols-[7rem_1fr] items-center gap-2">
            <Label className="text-right text-[11px] text-muted-foreground">WS 端口</Label>
            <Input value={port} onChange={(e) => setPort(e.target.value)} className="h-7 border-border bg-transparent font-mono text-xs" />
          </div>
          <p className="text-[11px] text-muted-foreground">改端口即时重绑;音箱侧 /data/open-xiaoai/server.txt 需指向新端口。</p>
          <Separator className="bg-border" />
          <CommandsEditor initial={speaker.commands} onChange={setCommands} />
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
  const [commands, setCommands] = useState<SpeakerCommands>({});

  const add = () => {
    const wsPort = parseInt(port);
    if (!wsPort) return toast.error("请填 WS 端口");
    api.addSpeaker({ wsPort, name: name.trim() || undefined, commands })
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
          <div className="grid grid-cols-[7rem_1fr] items-center gap-2">
            <Label className="text-right text-[11px] text-muted-foreground">WS 端口 *</Label>
            <Input value={port} onChange={(e) => setPort(e.target.value)} placeholder="如 4400" className="h-7 border-border bg-transparent font-mono text-xs" />
          </div>
          <div className="grid grid-cols-[7rem_1fr] items-center gap-2">
            <Label className="text-right text-[11px] text-muted-foreground">昵称</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="音箱-<端口>" className="h-7 border-border bg-transparent text-xs" />
          </div>
          <CommandsEditor initial={{}} onChange={setCommands} />
          <p className="text-[11px] text-muted-foreground">
            添加后请把音箱的 /data/open-xiaoai/server.txt 改为 ws://本机IP:新端口 并重启音箱。
          </p>
          <div className="flex justify-end">
            <Button size="sm" className="h-7 bg-amber-500 text-xs text-zinc-950 hover:bg-amber-400" onClick={add}>添加并监听</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function SpeakersTab({ speakers, onChanged }: { speakers: Speaker[]; onChanged: () => void }) {
  return (
    <div className="space-y-3">
      <div className="flex justify-end"><AddSpeakerDialog onChanged={onChanged} /></div>
      <div className="grid gap-3 md:grid-cols-2">
        {speakers.map((s) => (
          <Card key={s.id} className="border-border bg-card shadow-none">
            <CardHeader className="flex flex-row items-center justify-between py-3">
              <CardTitle className="flex items-center gap-2 text-sm font-medium">
                {s.name}
                <Badge variant="outline" className={s.online ? "border-amber-500/60 text-amber-500" : "border-border text-muted-foreground"}>
                  {s.online ? "在线" : "离线"}
                </Badge>
                {s.online && (
                  <Badge variant="outline" className="border-border text-muted-foreground">
                    {s.playing === "Playing" ? "播放中" : s.playing === "Paused" ? "已暂停" : "空闲"}
                  </Badge>
                )}
              </CardTitle>
              <div className="flex gap-1.5">
                <SpeakerSettingsDialog speaker={s} onChanged={onChanged} />
                <Button size="sm" variant="outline" className="h-7 border-border bg-transparent text-xs text-muted-foreground hover:bg-accent"
                  onClick={() => api.reconnect(s.id).then(() => toast.success("已断开,音箱将自动重连")).catch((e) => toast.error(String(e))).finally(onChanged)}>
                  重连
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-2 py-2 text-xs text-muted-foreground">
              <div className="flex justify-between"><span>WS 端口</span><span className="font-mono text-foreground">{s.wsPort}</span></div>
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
        ))}
      </div>
    </div>
  );
}
