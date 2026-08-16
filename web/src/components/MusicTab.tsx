import { useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { api, fmtDuration } from "@/lib/api";
import type { DirsInfo, Speaker } from "@/lib/types";
import { usePoll } from "@/lib/usePoll";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronDown, FolderCog } from "lucide-react";

type SortField = "title" | "artist" | "album" | "duration";

function SortHead({ label, field, sort, order, onSort }: {
  label: string; field: SortField; sort: SortField | ""; order: "asc" | "desc";
  onSort: (f: SortField) => void;
}) {
  const active = sort === field;
  return (
    <button className="flex items-center gap-0.5 text-xs hover:text-foreground" onClick={() => onSort(field)}>
      {label}
      {active && (order === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)}
    </button>
  );
}

function LibraryDialog({ onChanged }: { onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const { data, reload } = usePoll<DirsInfo>(() => api.dirs(), 60000);
  const [newDir, setNewDir] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploadDir, setUploadDir] = useState("");
  const [busy, setBusy] = useState(false);

  const dirs = data?.dirs ?? [];
  const defaultDir = data?.defaultDir ?? "";
  const effectiveUploadDir = uploadDir || defaultDir || dirs[0] || "";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-border bg-transparent px-3 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
        <FolderCog className="h-3.5 w-3.5" />管理曲库
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto border-border bg-background sm:max-w-lg">
        <DialogHeader><DialogTitle className="text-sm">管理曲库</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">曲库目录(服务器路径)</Label>
            {dirs.map((d) => (
              <div key={d} className="flex items-center gap-2 rounded border border-border px-2 py-1.5">
                <input
                  type="radio"
                  name="defaultDir"
                  checked={d === defaultDir}
                  onChange={() => api.setDefaultDir(d).then(reload).catch((e) => toast.error(String(e)))}
                  title="设为默认上传目录"
                />
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{d}</span>
                {d === defaultDir && <Badge variant="outline" className="border-amber-500/60 text-[10px] text-amber-500">默认</Badge>}
                <Button size="sm" variant="ghost" className="h-6 px-2 text-xs text-red-500"
                  onClick={() => {
                    if (!confirm(`将「${d}」移出曲库?\n仅移除索引,服务器文件不会被删除。`)) return;
                    api.removeDir(d).then(() => { reload(); onChanged(); }).catch((e) => toast.error(String(e)));
                  }}>
                  移除
                </Button>
              </div>
            ))}
            <div className="flex gap-1.5">
              <Input value={newDir} onChange={(e) => setNewDir(e.target.value)} placeholder="/path/to/music/新目录"
                className="h-7 border-border bg-transparent font-mono text-xs" />
              <Button size="sm" variant="outline" className="h-7 shrink-0 border-border bg-transparent text-xs"
                onClick={() => newDir.trim() && api.addDir(newDir.trim()).then(() => { setNewDir(""); reload(); onChanged(); }).catch((e) => toast.error(String(e)))}>
                添加目录
              </Button>
            </div>
          </div>
          <Separator className="bg-border" />
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">上传音乐</Label>
            <Select value={effectiveUploadDir} onValueChange={(v) => v && setUploadDir(v)}>
              <SelectTrigger className="h-7 border-border bg-transparent font-mono text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                {dirs.map((d) => <SelectItem key={d} value={d} className="font-mono text-xs">{d}{d === defaultDir ? "(默认)" : ""}</SelectItem>)}
              </SelectContent>
            </Select>
            <input ref={fileRef} type="file" accept=".mp3,.flac,.wav,.m4a,.aac,.ogg" className="text-xs text-muted-foreground" />
            <Button size="sm" disabled={busy} className="h-7 bg-amber-500 text-xs text-zinc-950 hover:bg-amber-400"
              onClick={() => {
                const f = fileRef.current?.files?.[0];
                if (!f) return toast.error("请选择文件");
                setBusy(true);
                api.uploadSong(f, effectiveUploadDir)
                  .then(() => { toast.success("上传成功,索引已更新"); onChanged(); })
                  .catch((e) => toast.error(String(e)))
                  .finally(() => setBusy(false));
              }}>
              {busy ? "上传中…" : "开始上传"}
            </Button>
          </div>
          <Separator className="bg-border" />
          <Button size="sm" variant="outline" className="h-7 border-border bg-transparent text-xs"
            onClick={() => api.refreshLibrary().then(() => toast.success("索引重建已开始")).catch((e) => toast.error(String(e)))}>
            立即重建索引
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function MusicTab({ speakers }: { speakers: Speaker[] }) {
  const visibleSpeakers = speakers.filter((s) => !s.hidden);
  const [q, setQ] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [sort, setSort] = useState<SortField | "">("");
  const [order, setOrder] = useState<"asc" | "desc">("asc");
  const [pageSize, setPageSize] = useState<string>("50");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const limit = pageSize === "all" ? ("all" as const) : parseInt(pageSize);
  const offset = typeof limit === "number" ? page * limit : 0;

  const { data, reload } = usePoll(
    () => api.songs({ q: submitted, sort: sort || undefined, order, limit, offset }),
    30000,
    [submitted, sort, order, pageSize, page],
  );
  const { data: albumData } = usePoll(() => api.albums(), 60000);

  const songs = useMemo(() => data?.songs ?? [], [data]);
  const total = data?.total ?? 0;
  const totalPages = typeof limit === "number" && limit > 0 ? Math.max(1, Math.ceil(total / limit)) : 1;

  const allChecked = songs.length > 0 && songs.every((s) => selected.has(s.path));
  const toggleAll = () => {
    const next = new Set(selected);
    if (allChecked) songs.forEach((s) => next.delete(s.path));
    else songs.forEach((s) => next.add(s.path));
    setSelected(next);
  };
  const toggleOne = (path: string) => {
    const next = new Set(selected);
    if (next.has(path)) next.delete(path); else next.add(path);
    setSelected(next);
  };

  const onSort = (f: SortField) => {
    if (sort === f) setOrder(order === "asc" ? "desc" : "asc");
    else { setSort(f); setOrder("asc"); }
    setPage(0);
  };

  const paths = [...selected];
  const batchPlay = (speakerId: string) =>
    api.play(speakerId, { paths }).then(() => toast.success(`已在目标音箱播放 ${paths.length} 首`)).catch((e) => toast.error(String(e)));
  const batchAppend = (speakerId: string) =>
    api.append(speakerId, paths).then(() => toast.success(`已追加 ${paths.length} 首到列表尾部`)).catch((e) => toast.error(String(e)));
  const batchDelete = () => {
    if (!confirm(`确认删除选中的 ${paths.length} 个文件?\n服务器文件将被物理删除!`)) return;
    Promise.allSettled(paths.map((p) => api.deleteSong(p)))
      .then(() => { toast.success("已删除"); setSelected(new Set()); reload(); });
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        <Input value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (setSubmitted(q.trim()), setPage(0))}
          placeholder="搜索歌名 / 歌手 / 专辑 / 文件名,空格分隔组合…"
          className="h-8 min-w-48 flex-1 border-border bg-transparent text-xs" />
        <Button size="sm" variant="outline" className="h-8 border-border bg-transparent text-xs"
          onClick={() => (setSubmitted(q.trim()), setPage(0))}>搜索</Button>
        <LibraryDialog onChanged={reload} />
      </div>

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded border border-amber-500/40 bg-amber-500/5 px-2 py-1.5">
          <Badge variant="outline" className="border-amber-500/60 text-amber-500">已选 {selected.size}</Badge>
          <DropdownMenu>
            <DropdownMenuTrigger className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-transparent px-2 text-xs hover:bg-accent">
              播放 <ChevronDown className="h-3 w-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {visibleSpeakers.map((s) => (
                <DropdownMenuItem key={s.id} onClick={() => batchPlay(s.id)}>{s.name}</DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-transparent px-2 text-xs hover:bg-accent">
              加入播放列表 <ChevronDown className="h-3 w-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {visibleSpeakers.map((s) => (
                <DropdownMenuItem key={s.id} onClick={() => batchAppend(s.id)}>{s.name}</DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-red-500" onClick={batchDelete}>删除所选</Button>
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-muted-foreground" onClick={() => setSelected(new Set())}>取消选择</Button>
        </div>
      )}

      <div className="overflow-x-auto rounded border border-border">
        <table className="w-full min-w-[640px]">
          <thead>
            <tr className="border-b border-border">
              <th className="w-8 px-2 py-2 text-left">
                <Checkbox checked={allChecked} onCheckedChange={toggleAll} />
              </th>
              <th className="px-2 py-2 text-left text-muted-foreground"><SortHead label="标题" field="title" sort={sort} order={order} onSort={onSort} /></th>
              <th className="px-2 py-2 text-left text-muted-foreground"><SortHead label="歌手" field="artist" sort={sort} order={order} onSort={onSort} /></th>
              <th className="px-2 py-2 text-left text-muted-foreground"><SortHead label="专辑" field="album" sort={sort} order={order} onSort={onSort} /></th>
              <th className="w-16 px-2 py-2 text-right text-muted-foreground"><SortHead label="时长" field="duration" sort={sort} order={order} onSort={onSort} /></th>
            </tr>
          </thead>
          <tbody>
            {songs.map((s) => (
              <tr key={s.path} className={`border-b border-border/60 last:border-0 hover:bg-accent/50 ${selected.has(s.path) ? "bg-amber-500/5" : ""}`}>
                <td className="px-2 py-1.5"><Checkbox checked={selected.has(s.path)} onCheckedChange={() => toggleOne(s.path)} /></td>
                <td className="max-w-52 truncate px-2 py-1.5 text-xs text-foreground">{s.title || s.filename}</td>
                <td className="max-w-28 truncate px-2 py-1.5 text-xs text-muted-foreground">{s.artist || "—"}</td>
                <td className="max-w-28 truncate px-2 py-1.5 text-xs text-muted-foreground">{s.album || "—"}</td>
                <td className="px-2 py-1.5 text-right font-mono text-xs text-muted-foreground">{fmtDuration(s.duration_sec)}</td>
              </tr>
            ))}
            {!songs.length && (
              <tr><td colSpan={5} className="px-2 py-6 text-center text-xs text-muted-foreground">无结果</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>共 {total} 首{typeof limit === "number" ? ` · 第 ${page + 1}/${totalPages} 页` : ""}</span>
        <div className="flex items-center gap-2">
          <Select value={pageSize} onValueChange={(v) => { if (!v) return; setPageSize(v); setPage(0); }}>
            <SelectTrigger className="h-7 w-24 border-border bg-transparent text-xs">
              <SelectValue>{(v: string) => (v === "all" ? "全部" : `${v} / 页`)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="20">20 / 页</SelectItem>
              <SelectItem value="50">50 / 页</SelectItem>
              <SelectItem value="100">100 / 页</SelectItem>
              <SelectItem value="all">全部</SelectItem>
            </SelectContent>
          </Select>
          {typeof limit === "number" && (
            <div className="flex gap-1">
              <Button size="sm" variant="outline" className="h-7 w-7 border-border bg-transparent p-0" disabled={page <= 0} onClick={() => setPage(page - 1)}>
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <Button size="sm" variant="outline" className="h-7 w-7 border-border bg-transparent p-0" disabled={page >= totalPages - 1} onClick={() => setPage(page + 1)}>
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* 专辑视图保留为快速入口 */}
      {albumData && albumData.albums.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">按专辑浏览({albumData.albums.length})</summary>
          <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {albumData.albums.map((a) => (
              <button key={`${a.album}|${a.artist}`}
                className="rounded border border-border bg-card px-3 py-2 text-left hover:border-amber-500/50"
                onClick={() => { setQ(a.album); setSubmitted(a.album); setPage(0); }}>
                <div className="truncate text-xs text-foreground">{a.album}</div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">{a.artist || "未知歌手"} · {a.count} 首</div>
              </button>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
