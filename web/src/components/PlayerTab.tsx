import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DndContext, closestCenter, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, MoreVertical, Pause, Play, SkipBack, SkipForward, Shuffle, ChevronDown } from "lucide-react";
import { api } from "@/lib/api";
import type { LoopMode, PlayerState, Song, Speaker } from "@/lib/types";
import { usePoll } from "@/lib/usePoll";
import { toast } from "sonner";

const LOOP_LABEL: Record<LoopMode, string> = { off: "不循环", one: "单曲循环", all: "列表循环", random: "随机循环" };

function SortableRow(props: {
  song: Song;
  index: number;
  state: PlayerState;
  speakerId: string;
  onChanged: () => void;
}) {
  const { song, index, state, speakerId, onChanged } = props;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: song.path });
  const isCurrent = index === state.cursor;
  const isPlayed = index < state.cursor;

  const op = (op: "playNow" | "pinTop" | "playNext" | "remove") =>
    api.listOp(speakerId, op, { index }).then(onChanged).catch((e) => toast.error(String(e)));

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex items-center gap-1 border-b border-border/60 px-1 py-1 last:border-0 ${
        isCurrent ? "bg-accent" : isPlayed ? "opacity-45" : ""
      } ${isDragging ? "z-10 shadow-lg" : ""}`}
    >
      <button {...attributes} {...listeners} className="cursor-grab touch-none p-1 text-muted-foreground hover:text-foreground">
        <GripVertical className="h-3.5 w-3.5" />
      </button>
      <button className="min-w-0 flex-1 text-left" onClick={() => op("playNow")}>
        <div className={`truncate text-xs ${isCurrent ? "font-medium text-amber-500" : "text-foreground"}`}>
          {song.title || song.filename}
        </div>
        <div className="truncate text-[11px] text-muted-foreground">
          {song.artist || "未知歌手"}{song.album ? ` · ${song.album}` : ""}
        </div>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground">
          <MoreVertical className="h-3.5 w-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-32">
          <DropdownMenuItem onClick={() => op("playNow")}>立即播放</DropdownMenuItem>
          <DropdownMenuItem onClick={() => op("pinTop")}>置顶</DropdownMenuItem>
          <DropdownMenuItem onClick={() => op("playNext")}>下一首播放</DropdownMenuItem>
          <DropdownMenuItem className="text-red-500" onClick={() => op("remove")}>从列表删除</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function PlayerCard({ speaker }: { speaker: Speaker }) {
  const { data: state, reload } = usePoll(() => api.playerState(speaker.id), 3000, [speaker.id]);
  const [localList, setLocalList] = useState<Song[]>([]);
  useEffect(() => { if (state) setLocalList(state.list); }, [state]);

  const playing = state?.playing === "Playing";

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = localList.findIndex((s) => s.path === active.id);
    const to = localList.findIndex((s) => s.path === over.id);
    if (from < 0 || to < 0) return;
    const next = [...localList];
    next.splice(to, 0, ...next.splice(from, 1));
    setLocalList(next);
    api.listOp(speaker.id, "reorder", { from, to }).then(reload).catch((e) => toast.error(String(e)));
  };

  return (
    <Card className="border-border bg-card shadow-none">
      <CardHeader className="flex flex-row items-center justify-between py-3">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          {speaker.name}
          <Badge variant="outline" className={speaker.online ? "border-amber-500/60 text-amber-500" : "border-border text-muted-foreground"}>
            {speaker.online ? "在线" : "离线"}
          </Badge>
          {state?.stopAfterCurrent && (
            <Badge variant="outline" className="border-amber-500/60 text-amber-500">播完即停</Badge>
          )}
        </CardTitle>
        <div className="w-28">
          <Select
            value={state?.loop ?? "off"}
            onValueChange={(v) => {
              if (!v) return;
              api.setLoop(speaker.id, v as LoopMode).then(reload).catch((e) => toast.error(String(e)));
            }}
          >
            <SelectTrigger className="h-7 border-border bg-transparent text-xs">
              <SelectValue>{(v: string) => LOOP_LABEL[v as LoopMode] ?? v}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(LOOP_LABEL) as LoopMode[]).map((m) => (
                <SelectItem key={m} value={m}>{LOOP_LABEL[m]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>

      <CardContent className="space-y-2.5 py-2">
        <div className="truncate text-sm text-foreground">
          {state?.cursor != null && state.cursor >= 0 && localList[state.cursor]
            ? `${localList[state.cursor].title} · ${localList[state.cursor].artist}`
            : "未在播放"}
        </div>

        {/* 音量 */}
        <div className="flex items-center gap-2">
          <span className="w-8 text-[11px] text-muted-foreground">音量</span>
          <Slider
            className="flex-1"
            value={[state?.volume ?? 0]}
            min={0}
            max={100}
            step={1}
            onValueChange={(v) => {
              const vol = Array.isArray(v) ? v[0] : v;
              // 本地即时反馈由下一轮轮询兜底
            }}
            onValueCommitted={(v) => {
              const vol = Array.isArray(v) ? v[0] : v;
              api.setVolume(speaker.id, vol ?? 0).then(reload).catch((e) => toast.error(String(e)));
            }}
          />
          <span className="w-8 text-right font-mono text-[11px] text-muted-foreground">{state?.volume ?? "—"}</span>
        </div>

        {/* 控制行 */}
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="sm" variant="outline" className="h-7 w-7 border-border bg-transparent p-0" onClick={() => api.playerAction(speaker.id, "prev").then(reload)}>
            <SkipBack className="h-3.5 w-3.5" />
          </Button>
          {/* split button:播放/停止 toggle(带文字) + 贴边下拉(两项恒显) */}
          <div className="flex">
            <Button size="sm" variant="outline" className="h-7 rounded-r-none border-border bg-transparent px-2 text-xs"
              onClick={() => api.toggle(speaker.id).then(reload).catch((e) => toast.error(String(e)))}>
              {playing ? <Pause className="mr-1 h-3.5 w-3.5" /> : <Play className="mr-1 h-3.5 w-3.5" />}
              {playing ? "停止" : "播放"}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger className="inline-flex h-7 items-center rounded-md rounded-l-none border border-l-0 border-border bg-transparent px-1 text-xs hover:bg-accent">
                <ChevronDown className="h-3.5 w-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-36">
                <DropdownMenuItem onClick={() =>
                  api.setStopAfterCurrent(speaker.id, !state?.stopAfterCurrent).then(reload).catch((e) => toast.error(String(e)))}>
                  {state?.stopAfterCurrent ? "取消播完即停" : "播完当前即停"}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => api.playerAction(speaker.id, "next").then(reload)}>
                  直接播放下一首
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <Button size="sm" variant="outline" className="h-7 border-border bg-transparent px-2 text-xs"
            onClick={() => api.playerAction(speaker.id, "random").then(reload).catch((e) => toast.error(String(e)))}>
            <Shuffle className="mr-1 h-3 w-3" />随便听听
          </Button>
          <KeywordPlay speakerId={speaker.id} onDone={reload} />
        </div>

        {/* 播放列表 */}
        {localList.length > 0 && (
          <div className="max-h-64 overflow-y-auto rounded border border-border">
            <DndContext collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={localList.map((s) => s.path)} strategy={verticalListSortingStrategy}>
                {localList.map((s, i) => (
                  <SortableRow key={s.path} song={s} index={i} state={state!} speakerId={speaker.id} onChanged={reload} />
                ))}
              </SortableContext>
            </DndContext>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function KeywordPlay({ speakerId, onDone }: { speakerId: string; onDone: () => void }) {
  const [kw, setKw] = useState("");
  const go = () => kw.trim() && api.play(speakerId, { keyword: kw.trim() }).then(onDone).catch((e) => toast.error(String(e)));
  return (
    <div className="flex min-w-40 flex-1 gap-1.5">
      <Input value={kw} onChange={(e) => setKw(e.target.value)} onKeyDown={(e) => e.key === "Enter" && go()}
        placeholder="关键词点播(同语音语义)…" className="h-7 border-border bg-transparent text-xs" />
      <Button size="sm" variant="outline" className="h-7 shrink-0 border-border bg-transparent text-xs" onClick={go}>播放</Button>
    </div>
  );
}

export function PlayerTab({ speakers }: { speakers: Speaker[] }) {
  const visible = speakers.filter((s) => !s.hidden);
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {visible.map((s) => <PlayerCard key={s.id} speaker={s} />)}
      {!visible.length && <p className="text-xs text-muted-foreground">没有可见实例(全部已隐藏)</p>}
    </div>
  );
}
