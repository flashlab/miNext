import { useEffect } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Toaster } from "@/components/ui/sonner";
import { ensureSync, refreshSpeakers, useSync } from "@/lib/sync";
import { useTheme, ThemeToggle } from "@/lib/theme";
import { version } from "../package.json";
import { SpeakersTab } from "@/components/SpeakersTab";
import { MusicTab } from "@/components/MusicTab";
import { DownloadTab } from "@/components/DownloadTab";
import { PlayerTab } from "@/components/PlayerTab";
import { ToolsTab } from "@/components/ToolsTab";

export default function App() {
  const speakers = useSync((s) => s.speakers);
  const stats = useSync((s) => s.stats);
  const connected = useSync((s) => s.connected);
  useEffect(() => {
    ensureSync(); // 建立 /api/ws 实时通道(幂等)
  }, []);
  const { theme, setTheme } = useTheme();

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-5xl px-4 py-4">
        <header className="mb-4 flex items-center justify-between">
          <div className="flex items-baseline gap-2">
            <h1 className="text-base font-semibold tracking-tight">miNext</h1>
            <span className="text-xs text-muted-foreground">小爱音箱管理</span>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${connected ? "bg-emerald-500" : "bg-amber-500"}`}
              title={connected ? "实时同步已连接" : "实时同步断开(自动重连中),状态可能滞后"}
            />
            <span>曲库 {stats?.total ?? "…"} 首{stats?.refreshing ? " · 索引中…" : ""}</span>
            <ThemeToggle theme={theme} setTheme={setTheme} />
          </div>
        </header>

        <Tabs defaultValue="speakers">
          <TabsList className="mb-3 h-8">
            <TabsTrigger value="speakers" className="text-xs">实例</TabsTrigger>
            <TabsTrigger value="player" className="text-xs">播放</TabsTrigger>
            <TabsTrigger value="music" className="text-xs">本地</TabsTrigger>
            <TabsTrigger value="download" className="text-xs">下载</TabsTrigger>
            <TabsTrigger value="tools" className="text-xs">工具</TabsTrigger>
          </TabsList>
          <TabsContent value="speakers">
            <SpeakersTab speakers={speakers ?? []} onChanged={refreshSpeakers} />
          </TabsContent>
          <TabsContent value="player">
            <PlayerTab speakers={speakers ?? []} />
          </TabsContent>
          <TabsContent value="music" keepMounted>
            <MusicTab speakers={speakers ?? []} />
          </TabsContent>
          <TabsContent value="download" keepMounted>
            <DownloadTab speakers={speakers ?? []} />
          </TabsContent>
          <TabsContent value="tools">
            <ToolsTab speakers={speakers ?? []} onChanged={refreshSpeakers} />
          </TabsContent>
        </Tabs>

        <footer className="mt-6 text-center text-[11px] text-muted-foreground">
          🌱 Built by{" "}
          <a className="underline decoration-border hover:text-foreground" href="https://github.com/flashlab" target="_blank" rel="noreferrer">
            ZZBD
          </a>
          {" "}· v{version}
        </footer>
      </div>
      <Toaster position="bottom-right" />
    </div>
  );
}
