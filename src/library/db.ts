// 曲库 + 实例 + 设置(sqlite,bun:sqlite 零依赖)
import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { normText } from "./t2s";
import { compileQuery } from "./query";

export interface SongRow {
  id: number;
  path: string;
  title: string;
  artist: string;
  album: string;
  filename: string;
  dir: string;
  ext: string;
  duration_sec: number;
  size: number;
  mtime_ns: number;
  updated_at: number;
  deleted_at: number; // 0=正常;>0=标记删除(回收站)时间戳,文件仍在磁盘
  // 搜索影子列:繁→简 + 小写;显示仍用原列
  norm_title: string;
  norm_artist: string;
  norm_album: string;
  norm_filename: string;
}

export interface SpeakerRow {
  id: string;
  name: string;
  ws_port: number;
  commands: string; // JSON: CommandsConfig 的子集(每实例覆盖)
  hidden: number;
  token: string; // 非空时 WS 需走 /ws/<token> 路径(公网门控)
  last_ip: string;
  created_at: number;
}

const SORTABLE: Record<string, string> = {
  title: "title COLLATE NOCASE",
  artist: "artist COLLATE NOCASE",
  album: "album COLLATE NOCASE",
  duration: "duration_sec",
  filename: "filename COLLATE NOCASE",
};

export class LibraryDb {
  readonly db: Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run(`CREATE TABLE IF NOT EXISTS songs (
      id INTEGER PRIMARY KEY,
      path TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      artist TEXT NOT NULL DEFAULT '',
      album TEXT NOT NULL DEFAULT '',
      filename TEXT NOT NULL,
      dir TEXT NOT NULL DEFAULT '',
      ext TEXT NOT NULL DEFAULT '',
      duration_sec REAL NOT NULL DEFAULT 0,
      size INTEGER NOT NULL DEFAULT 0,
      mtime_ns INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    )`);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_songs_artist ON songs(artist)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_songs_album ON songs(album)");
    this.db.run(`CREATE TABLE IF NOT EXISTS speakers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      ws_port INTEGER UNIQUE NOT NULL,
      commands TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL DEFAULT 0
    )`);
    this.db.run(`CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`);
    // 列级迁移(老库补列)
    const cols = new Set(
      (this.db.query("PRAGMA table_info(speakers)").all() as { name: string }[]).map((c) => c.name),
    );
    if (!cols.has("hidden")) this.db.run("ALTER TABLE speakers ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0");
    if (!cols.has("token")) this.db.run("ALTER TABLE speakers ADD COLUMN token TEXT NOT NULL DEFAULT ''");
    if (!cols.has("last_ip")) this.db.run("ALTER TABLE speakers ADD COLUMN last_ip TEXT NOT NULL DEFAULT ''");
    const songCols = new Set(
      (this.db.query("PRAGMA table_info(songs)").all() as { name: string }[]).map((c) => c.name),
    );
    if (!songCols.has("deleted_at")) this.db.run("ALTER TABLE songs ADD COLUMN deleted_at INTEGER NOT NULL DEFAULT 0");
    for (const c of ["norm_title", "norm_artist", "norm_album", "norm_filename"]) {
      if (!songCols.has(c)) this.db.run(`ALTER TABLE songs ADD COLUMN ${c} TEXT NOT NULL DEFAULT ''`);
    }
    // 影子列回填(新增列后一次性)
    const stale = this.db.query("SELECT id, title, artist, album, filename FROM songs WHERE norm_filename = ''").all() as { id: number; title: string; artist: string; album: string; filename: string }[];
    if (stale.length) {
      const stmt = this.db.prepare("UPDATE songs SET norm_title=?, norm_artist=?, norm_album=?, norm_filename=? WHERE id=?");
      const tx = this.db.transaction(() => {
        for (const r of stale) stmt.run(normText(r.title), normText(r.artist), normText(r.album), normText(r.filename), r.id);
      });
      tx();
      console.log(`影子列回填完成: ${stale.length} 首`);
    }
    this.db.run("CREATE INDEX IF NOT EXISTS idx_songs_norm_title ON songs(norm_title)");
  }

  // ---- settings ----
  getSetting(key: string): string | null {
    const r = this.db.query("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | null;
    return r?.value ?? null;
  }
  setSetting(key: string, value: string) {
    this.db.run("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [key, value]);
  }
  getSettingJSON<T>(key: string): T | null {
    const v = this.getSetting(key);
    if (!v) return null;
    try { return JSON.parse(v) as T; } catch { return null; }
  }
  setSettingJSON(key: string, value: unknown) {
    this.setSetting(key, JSON.stringify(value));
  }

  // ---- speakers ----
  listSpeakers(): SpeakerRow[] {
    return this.db.query("SELECT * FROM speakers ORDER BY ws_port").all() as SpeakerRow[];
  }
  addSpeaker(s: SpeakerRow) {
    this.db.run("INSERT INTO speakers (id,name,ws_port,commands,hidden,token,last_ip,created_at) VALUES (?,?,?,?,?,?,?,?)",
      [s.id, s.name, s.ws_port, s.commands, s.hidden ?? 0, s.token ?? "", s.last_ip ?? "", s.created_at]);
  }
  updateSpeaker(id: string, patch: { name?: string; ws_port?: number; commands?: string; hidden?: number; token?: string; last_ip?: string }) {
    if (patch.name !== undefined) this.db.run("UPDATE speakers SET name=? WHERE id=?", [patch.name, id]);
    if (patch.ws_port !== undefined) this.db.run("UPDATE speakers SET ws_port=? WHERE id=?", [patch.ws_port, id]);
    if (patch.commands !== undefined) this.db.run("UPDATE speakers SET commands=? WHERE id=?", [patch.commands, id]);
    if (patch.hidden !== undefined) this.db.run("UPDATE speakers SET hidden=? WHERE id=?", [patch.hidden, id]);
    if (patch.token !== undefined) this.db.run("UPDATE speakers SET token=? WHERE id=?", [patch.token, id]);
    if (patch.last_ip !== undefined) this.db.run("UPDATE speakers SET last_ip=? WHERE id=?", [patch.last_ip, id]);
  }
  deleteSpeaker(id: string) {
    this.db.run("DELETE FROM speakers WHERE id=?", [id]);
  }

  // ---- songs ----
  upsertSong(s: Omit<SongRow, "id" | "updated_at" | "deleted_at" | "norm_title" | "norm_artist" | "norm_album" | "norm_filename">) {
    this.db.run(
      `INSERT INTO songs (path,title,artist,album,filename,dir,ext,duration_sec,size,mtime_ns,updated_at,norm_title,norm_artist,norm_album,norm_filename)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(path) DO UPDATE SET
         title=excluded.title, artist=excluded.artist, album=excluded.album,
         filename=excluded.filename, dir=excluded.dir, ext=excluded.ext,
         duration_sec=excluded.duration_sec, size=excluded.size,
         mtime_ns=excluded.mtime_ns, updated_at=excluded.updated_at,
         norm_title=excluded.norm_title, norm_artist=excluded.norm_artist,
         norm_album=excluded.norm_album, norm_filename=excluded.norm_filename`,
      [s.path, s.title, s.artist, s.album, s.filename, s.dir, s.ext, s.duration_sec, s.size, s.mtime_ns, Date.now(),
       normText(s.title), normText(s.artist), normText(s.album), normText(s.filename)],
    );
  }

  removePathsOutside(validDirs: string[]): number {
    if (!validDirs.length) return this.db.run("DELETE FROM songs").changes;
    const conds = validDirs.map(() => "dir || '/' NOT LIKE ?").join(" AND ");
    return this.db.run(`DELETE FROM songs WHERE ${conds}`, validDirs.map((d) => `${d}%`)).changes;
  }

  removePathsNotIn(validPaths: string[]): number {
    if (validPaths.length === 0) return 0; // 保护:目录不可读导致的空扫描不清库
    const placeholders = validPaths.map(() => "?").join(",");
    return this.db.run(`DELETE FROM songs WHERE path NOT IN (${placeholders})`, validPaths).changes;
  }

  removeByPath(path: string): boolean {
    return this.db.run("DELETE FROM songs WHERE path = ?", [path]).changes > 0;
  }

  renamePath(oldPath: string, newPath: string, filename: string, dir: string) {
    this.db.run(
      "UPDATE songs SET path=?, filename=?, dir=?, updated_at=?, norm_filename=? WHERE path=?",
      [newPath, filename, dir, Date.now(), normText(filename), oldPath],
    );
  }

  count(): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM songs WHERE deleted_at = 0").get() as { n: number }).n;
  }

  allPathsMtime(): Map<string, number> {
    const rows = this.db.query("SELECT path, mtime_ns FROM songs").all() as { path: string; mtime_ns: number }[];
    return new Map(rows.map((r) => [r.path, r.mtime_ns]));
  }

  getByPaths(paths: string[]): SongRow[] {
    if (!paths.length) return [];
    const ph = paths.map(() => "?").join(",");
    return this.db.query(`SELECT * FROM songs WHERE deleted_at = 0 AND path IN (${ph})`).all(...paths) as SongRow[];
  }

  /** 含回收站条目的单路径查询(撤销校验用) */
  getByPathAny(path: string): SongRow | null {
    return (this.db.query("SELECT * FROM songs WHERE path = ?").get(path) as SongRow | null) ?? null;
  }

  /** 字段语法搜索 + 排序 + 分页。q 为空=全部(仅排除回收站)。返回过滤后总数。 */
  search(opts: {
    q: string;
    sort?: string;
    order?: "asc" | "desc";
    limit?: number;
    offset?: number;
  }): { songs: SongRow[]; total: number } {
    const compiled = compileQuery(opts.q);
    const where = "WHERE deleted_at = 0" + (compiled ? ` AND ${compiled.where}` : "");
    const params = compiled?.params ?? [];
    const total = (this.db.query(`SELECT COUNT(*) AS n FROM songs ${where}`).get(...params) as { n: number }).n;

    const sortCol = SORTABLE[opts.sort ?? ""] ?? "artist COLLATE NOCASE, album COLLATE NOCASE, title COLLATE NOCASE";
    const dir = opts.order === "desc" ? "DESC" : "ASC";
    const orderBy = SORTABLE[opts.sort ?? ""] ? `ORDER BY ${sortCol} ${dir}` : `ORDER BY ${sortCol}`;

    let sql = `SELECT * FROM songs ${where} ${orderBy}`;
    const p = [...params];
    if (opts.limit && opts.limit > 0) {
      sql += " LIMIT ? OFFSET ?";
      p.push(String(opts.limit), String(opts.offset ?? 0));
    }
    const songs = this.db.query(sql).all(...p) as SongRow[];
    return { songs, total };
  }

  searchConstrained(opts: { artist?: string; album?: string; title?: string; limit?: number }): SongRow[] {
    const conds: string[] = ["deleted_at = 0"];
    const params: string[] = [];
    if (opts.artist) { conds.push("instr(norm_artist, ?) > 0"); params.push(normText(opts.artist)); }
    if (opts.album) { conds.push("instr(norm_album, ?) > 0"); params.push(normText(opts.album)); }
    if (opts.title) {
      conds.push("(instr(norm_title, ?) > 0 OR instr(norm_filename, ?) > 0)");
      params.push(normText(opts.title), normText(opts.title));
    }
    if (conds.length < 2) return [];
    return this.db.query(`SELECT * FROM songs WHERE ${conds.join(" AND ")} LIMIT ?`)
      .all(...params, opts.limit ?? 100) as SongRow[];
  }

  albums(): { album: string; artist: string; count: number }[] {
    return this.db.query(
      `SELECT album, artist, COUNT(*) AS count FROM songs WHERE album != '' AND deleted_at = 0 GROUP BY album, artist ORDER BY count DESC`,
    ).all() as { album: string; artist: string; count: number }[];
  }

  randomPick(limit: number): SongRow[] {
    return this.db.query("SELECT * FROM songs WHERE deleted_at = 0 ORDER BY RANDOM() LIMIT ?").all(limit) as SongRow[];
  }

  // ---- 回收站(标记删除) ----
  /** 标记删除;返回行(含已是回收站状态的),不存在返回 null */
  markDeleted(path: string): SongRow | null {
    const row = this.getByPathAny(path);
    if (!row) return null;
    if (!row.deleted_at) this.db.run("UPDATE songs SET deleted_at = ? WHERE path = ?", [Date.now(), path]);
    return { ...row, deleted_at: row.deleted_at || Date.now() };
  }

  /** 恢复(清标记);返回实际恢复条数 */
  restore(paths: string[]): number {
    if (!paths.length) return 0;
    const ph = paths.map(() => "?").join(",");
    return this.db.run(`UPDATE songs SET deleted_at = 0 WHERE deleted_at != 0 AND path IN (${ph})`, paths).changes;
  }

  /** 下载落盘路径命中墓碑时复活(重新下载=明确想要) */
  resurrectIfTrashed(path: string) {
    this.db.run("UPDATE songs SET deleted_at = 0 WHERE path = ? AND deleted_at != 0", [path]);
  }

  trashList(): SongRow[] {
    return this.db.query("SELECT * FROM songs WHERE deleted_at != 0 ORDER BY deleted_at DESC").all() as SongRow[];
  }

  trashCount(): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM songs WHERE deleted_at != 0").get() as { n: number }).n;
  }

  /** 物理删除回收站条目(调用方负责 unlink 文件);返回被删行 */
  purgeTrashed(paths?: string[]): SongRow[] {
    const rows = paths?.length
      ? (this.db.query(`SELECT * FROM songs WHERE deleted_at != 0 AND path IN (${paths.map(() => "?").join(",")})`).all(...paths) as SongRow[])
      : this.trashList();
    if (!rows.length) return [];
    const ph = rows.map(() => "?").join(",");
    this.db.run(`DELETE FROM songs WHERE path IN (${ph})`, rows.map((r) => r.path));
    return rows;
  }
}
