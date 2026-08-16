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

export function ToolsTab({ speakers }: { speakers: Speaker[] }) {
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
