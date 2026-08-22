// 字段搜索语法:[ti]标题 [ar]歌手 [al]专辑 [fn]文件名;and/or 显式运算(and 优先);
// 空格分隔=隐式 and;无标签裸词=四字段 OR;* = 通配(0+ 字符);无 * 用 instr 子串(避开 LIKE)
import { normText } from "./t2s";

const FIELDS: Record<string, string> = {
  ti: "norm_title",
  ar: "norm_artist",
  al: "norm_album",
  fn: "norm_filename",
};
const ALL_FIELDS = Object.values(FIELDS);

export interface CompiledQuery {
  where: string;
  params: string[];
}

function termSql(rawValue: string, field?: string): CompiledQuery | null {
  const v = normText(rawValue);
  if (!v) return null;
  const cols = field ? [FIELDS[field]] : ALL_FIELDS;
  if (v.includes("*")) {
    // * → %(LIKE 通配);先转义 \,%,_;首尾包 % 保持"包含"语义与 instr 一致
    const like = "%" + v.replace(/[\\%_]/g, (m) => `\\${m}`).replace(/\*/g, "%") + "%";
    return { where: `(${cols.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(" OR ")})`, params: cols.map(() => like) };
  }
  return { where: `(${cols.map((c) => `instr(${c}, ?) > 0`).join(" OR ")})`, params: cols.map(() => v) };
}

/** 解析查询;语法异常时回退为整串裸词 */
export function compileQuery(q: string): CompiledQuery | null {
  const tokens = q.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;

  type Item = { kind: "term"; field?: string; value: string } | { kind: "op"; op: "and" | "or" };
  const items: Item[] = [];
  for (const t of tokens) {
    const low = t.toLowerCase();
    if (low === "and" || low === "or") {
      items.push({ kind: "op", op: low });
      continue;
    }
    const m = /^\[(ti|ar|al|fn)\](.*)$/i.exec(t);
    if (m) {
      if (!m[2]) return fallback(q); // 空标签值 → 回退
      items.push({ kind: "term", field: m[1].toLowerCase(), value: m[2] });
      continue;
    }
    if (/^\[(ti|ar|al|fn)\]$/i.test(t)) return fallback(q);
    items.push({ kind: "term", value: t });
  }
  // 语法校验:首/尾不能是 op,op 不能相邻
  if (items[0]?.kind === "op" || items[items.length - 1]?.kind === "op") return fallback(q);
  for (let i = 1; i < items.length; i++) {
    if (items[i].kind === "op" && items[i - 1].kind === "op") return fallback(q);
  }

  // or 分组(and 优先);组内隐式/显式 and
  const orGroups: CompiledQuery[][] = [[]];
  for (const it of items) {
    if (it.kind === "op") {
      if (it.op === "or") orGroups.push([]);
      continue; // and 靠相邻隐含
    }
    const t = termSql(it.value, it.field);
    if (t) orGroups[orGroups.length - 1].push(t);
  }
  const parts: string[] = [];
  const params: string[] = [];
  for (const g of orGroups) {
    if (!g.length) continue;
    parts.push(g.length > 1 ? `(${g.map((t) => t.where).join(" AND ")})` : g[0].where);
    for (const t of g) params.push(...t.params);
  }
  if (!parts.length) return null;
  return { where: parts.length > 1 ? `(${parts.join(" OR ")})` : parts[0], params };
}

function fallback(q: string): CompiledQuery | null {
  return termSql(q);
}
