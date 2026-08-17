import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Toaster } from "@/components/ui/sonner";
import { api } from "@/lib/api";
import { usePoll } from "@/lib/usePoll";
import { useTheme, ThemeToggle } from "@/lib/theme";
import { version } from "../package.json";
import { SpeakersTab } from "@/components/SpeakersTab";
import { MusicTab } from "@/components/MusicTab";
import { DownloadTab } from "@/components/DownloadTab";
import { PlayerTab } from "@/components/PlayerTab";
import { ToolsTab } from "@/components/ToolsTab";

export default function App() {
  const { data: speakers, reload } = usePoll(() => api.speakers(), 3000);
  const { data: stats } = usePoll(() => api.libraryStats(), 15000);
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
            <SpeakersTab speakers={speakers ?? []} onChanged={reload} />
          </TabsContent>
          <TabsContent value="player">
            <PlayerTab speakers={speakers ?? []} />
          </TabsContent>
          <TabsContent value="music">
            <MusicTab speakers={speakers ?? []} />
          </TabsContent>
          <TabsContent value="download">
            <DownloadTab />
          </TabsContent>
          <TabsContent value="tools">
            <ToolsTab speakers={speakers ?? []} />
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
