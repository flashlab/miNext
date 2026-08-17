import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from "@/components/ui/dialog";
import { api } from "@/lib/api";
import type { DirsInfo } from "@/lib/types";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, Folder, FolderOpen, FolderCog } from "lucide-react";

interface NodeState {
  children?: string[]; // undefined = 未加载
  expanded: boolean;
}

/** 曲库目录树选择器:根 = 曲库目录,懒加载子目录 */
export function DirTreePicker({ value, onSelect, triggerLabel = "选择路径" }: {
  value: string;
  onSelect: (path: string) => void;
  triggerLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [roots, setRoots] = useState<string[]>([]);
  const [nodes, setNodes] = useState<Map<string, NodeState>>(new Map());
  const [picked, setPicked] = useState(value);

  useEffect(() => {
    if (!open) return;
    setPicked(value);
    api.dirs()
      .then((d: DirsInfo) => {
        setRoots(d.dirs);
        setNodes(new Map(d.dirs.map((r) => [r, { expanded: false }])));
      })
      .catch((e) => toast.error(String(e)));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = async (path: string) => {
    const n = nodes.get(path);
    if (!n) return;
    if (n.children === undefined) {
      setNodes(new Map(nodes).set(path, { ...n, expanded: true }));
      try {
        const r = await api.libraryTree(path);
        const next = new Map(nodes);
        next.set(path, { children: r.dirs.map((d) => `${path}/${d}`), expanded: true });
        for (const d of r.dirs) {
          const cp = `${path}/${d}`;
          if (!next.has(cp)) next.set(cp, { expanded: false });
        }
        setNodes(next);
      } catch (e) {
        toast.error(String(e));
      }
    } else {
      setNodes(new Map(nodes).set(path, { ...n, expanded: !n.expanded }));
    }
  };

  const renderNode = (path: string, depth: number): React.ReactNode => {
    const n = nodes.get(path);
    const name = path.split("/").pop() || path;
    const hasKids = n?.children === undefined || n.children.length > 0;
    return (
      <div key={path}>
        <div
          className={`flex items-center gap-1 rounded px-1 py-1 text-xs hover:bg-accent ${picked === path ? "bg-amber-500/10 text-amber-500" : ""}`}
          style={{ paddingLeft: `${depth * 14 + 4}px` }}
        >
          {hasKids ? (
            <button className="p-0.5 text-muted-foreground" onClick={() => toggle(path)}>
              {n?.expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            </button>
          ) : (
            <span className="w-4" />
          )}
          <button className="flex min-w-0 flex-1 items-center gap-1.5 text-left" onClick={() => setPicked(path)} onDoubleClick={() => toggle(path)}>
            {n?.expanded ? <FolderOpen className="h-3.5 w-3.5 shrink-0 text-amber-500/80" /> : <Folder className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
            <span className="truncate">{name}</span>
          </button>
        </div>
        {n?.expanded && n.children?.map((c) => renderNode(c, depth + 1))}
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border bg-transparent px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
        <FolderCog className="h-3 w-3" />{triggerLabel}
      </DialogTrigger>
      <DialogContent className="border-border bg-background sm:max-w-md">
        <DialogHeader><DialogTitle className="text-sm">选择路径</DialogTitle></DialogHeader>
        <div className="max-h-72 overflow-y-auto rounded border border-border p-1">
          {roots.map((r) => renderNode(r, 0))}
          {!roots.length && <p className="p-3 text-center text-xs text-muted-foreground">暂无曲库目录</p>}
        </div>
        <div className="rounded border border-border bg-muted/40 px-2 py-1.5 font-mono text-[11px] break-all text-muted-foreground">
          {picked || "未选择"}
        </div>
        <div className="flex justify-end">
          <Button size="sm" className="h-7 bg-amber-500 text-xs text-zinc-950 hover:bg-amber-400"
            onClick={() => { if (picked) { onSelect(picked); setOpen(false); } }}>
            确定
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
