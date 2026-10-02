import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { api } from "@/lib/api";
import type { Speaker } from "@/lib/types";
import { toast } from "sonner";

function ToolRow({ label, placeholder, onRun }: {
  label: string;
  placeholder: string;
  onRun: (value: string) => Promise<{ ok: boolean; stdout: string }>;
}) {
  const [v, setV] = useState("");
  const [busy, setBusy] = useState(false);
  const run = () => {
    if (!v.trim()) return;
    setBusy(true);
    onRun(v.trim())
      .then((r) => (r.ok ? toast.success(`${label}已发送`) : toast.error(`${label}失败: ${r.stdout.slice(0, 120)}`)))
      .catch((e) => toast.error(String(e)))
      .finally(() => setBusy(false));
  };
  return (
    <div className="flex gap-1.5">
      <Input value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === "Enter" && run()}
        placeholder={placeholder} className="h-7 border-border bg-transparent text-xs" />
      <Button size="sm" variant="outline" disabled={busy} className="h-7 shrink-0 border-border bg-transparent text-xs" onClick={run}>
        {label}
      </Button>
    </div>
  );
}

function ShellTool({ speakerId }: { speakerId: string }) {
  const [v, setV] = useState("");
  const [out, setOut] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-1.5">
      <div className="flex gap-1.5">
        <Input value={v} onChange={(e) => setV(e.target.value)} placeholder="ubus list mediaplayer …"
          className="h-7 border-border bg-transparent font-mono text-xs" />
        <Button size="sm" variant="outline" disabled={busy}
          className="h-7 shrink-0 border-red-500/40 bg-transparent text-xs text-red-500"
          onClick={() => {
            if (!v.trim()) return;
            setBusy(true);
            api.toolShell(speakerId, v.trim())
              .then((r) => setOut(r.stdout + (r.stderr ? `\n[stderr] ${r.stderr}` : "")))
              .catch((e) => toast.error(String(e)))
              .finally(() => setBusy(false));
          }}>
          Shell
        </Button>
      </div>
      {out && (
        <pre className="max-h-40 overflow-auto rounded border border-border bg-muted/50 p-2 font-mono text-[11px] text-muted-foreground">{out}</pre>
      )}
    </div>
  );
}

/** 按钮态样式:激活=实心琥珀,常态=纯边框 */
function toggleClass(active: boolean): string {
  return `h-7 whitespace-nowrap rounded border px-2 text-xs ${
    active
      ? "border-amber-500 bg-amber-500 text-zinc-950 hover:bg-amber-400"
      : "border-border bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground"
  }`;
}

/** 禁用原生语音(5 分钟):激活期间小爱回答一开口就被切断,只响应 miNext 关键词 */
function NativeVoiceButton({ speaker, onChanged }: { speaker: Speaker; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const until = speaker.nativeVoiceDisabledUntil ?? 0;
  const active = until > Date.now();
  const mins = Math.max(1, Math.ceil((until - Date.now()) / 60_000));
  const click = () => {
    setBusy(true);
    api.toolNativeVoice(speaker.id, !active)
      .then(() => { toast.success(active ? "已恢复原生语音" : "已禁用原生语音(5 分钟)"); onChanged(); })
      .catch((e) => toast.error(String(e)))
      .finally(() => setBusy(false));
  };
  return (
    <button type="button" disabled={busy} onClick={click} className={toggleClass(active)}>
      {active ? `解除禁用 · 剩 ${mins} 分` : "禁用原生语音(5 分钟)"}
    </button>
  );
}

/** 禁用麦克风:pnshelper 原语开关,状态读音箱真实值(与物理静音键同步) */
function MicButton({ speaker, onChanged }: { speaker: Speaker; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const muted = speaker.micMuted === true;
  const click = () => {
    setBusy(true);
    api.toolMic(speaker.id, !muted)
      .then((r) => { toast.success(r.micMuted ? "麦克风已禁用" : "麦克风已恢复"); onChanged(); })
      .catch((e) => toast.error(String(e)))
      .finally(() => setBusy(false));
  };
  return (
    <button type="button" disabled={busy} onClick={click} className={toggleClass(muted)}>
      {muted ? "解除禁用" : "禁用麦克风"}
    </button>
  );
}

export function ToolsTab({ speakers, onChanged }: { speakers: Speaker[]; onChanged: () => void }) {
  const visible = speakers.filter((s) => !s.hidden);
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {visible.map((s) => (
        <Card key={s.id} className="border-border bg-card shadow-none">
          <CardHeader className="flex flex-row items-center justify-between py-3">
            <CardTitle className="text-sm font-medium">{s.name}</CardTitle>
            <Badge variant="outline" className={s.online ? "border-amber-500/60 text-amber-500" : "border-border text-muted-foreground"}>
              {s.online ? "在线" : "离线"}
            </Badge>
          </CardHeader>
          <CardContent className="space-y-2 py-2">
            <ToolRow label="播 URL" placeholder="http(s) 音频地址…" onRun={(url) => api.toolPlayUrl(s.id, url)} />
            <ToolRow label="TTS" placeholder="让小爱说…" onRun={(text) => api.toolSay(s.id, text)} />
            <ToolRow label="问小爱" placeholder="向小爱提问…" onRun={(text) => api.toolAsk(s.id, text)} />
            <div className="flex flex-wrap items-center gap-1.5">
              <NativeVoiceButton speaker={s} onChanged={onChanged} />
              <MicButton speaker={s} onChanged={onChanged} />
            </div>
            <details>
              <summary className="cursor-pointer text-[11px] text-muted-foreground hover:text-foreground">高级:在音箱上执行 shell</summary>
              <div className="mt-2"><ShellTool speakerId={s.id} /></div>
            </details>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
