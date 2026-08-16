// 曲库 + 实例 + 设置(sqlite,bun:sqlite 零依赖)
import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

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
  upsertSong(s: Omit<SongRow, "id" | "updated_at">) {
    this.db.run(
      `INSERT INTO songs (path,title,artist,album,filename,dir,ext,duration_sec,size,mtime_ns,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(path) DO UPDATE SET
         title=excluded.title, artist=excluded.artist, album=excluded.album,
         filename=excluded.filename, dir=excluded.dir, ext=excluded.ext,
         duration_sec=excluded.duration_sec, size=excluded.size,
         mtime_ns=excluded.mtime_ns, updated_at=excluded.updated_at`,
      [s.path, s.title, s.artist, s.album, s.filename, s.dir, s.ext, s.duration_sec, s.size, s.mtime_ns, Date.now()],
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
      "UPDATE songs SET path=?, filename=?, dir=?, updated_at=? WHERE path=?",
      [newPath, filename, dir, Date.now(), oldPath],
    );
  }

  count(): number {
    return (this.db.query("SELECT COUNT(*) AS n FROM songs").get() as { n: number }).n;
  }

  allPathsMtime(): Map<string, number> {
    const rows = this.db.query("SELECT path, mtime_ns FROM songs").all() as { path: string; mtime_ns: number }[];
    return new Map(rows.map((r) => [r.path, r.mtime_ns]));
  }

  getByPaths(paths: string[]): SongRow[] {
    if (!paths.length) return [];
    const ph = paths.map(() => "?").join(",");
    return this.db.query(`SELECT * FROM songs WHERE path IN (${ph})`).all(...paths) as SongRow[];
  }

  /** 组合搜索 + 排序 + 分页。terms 为空=全部。返回过滤后总数。 */
  search(opts: {
    terms: string[];
    sort?: string;
    order?: "asc" | "desc";
    limit?: number;
    offset?: number;
  }): { songs: SongRow[]; total: number } {
    const terms = opts.terms.filter(Boolean);
    const where = terms.length
      ? "WHERE " + terms.map(() => "(lower(title) LIKE ? OR lower(artist) LIKE ? OR lower(album) LIKE ? OR lower(filename) LIKE ?)").join(" AND ")
      : "";
    const params = terms.flatMap((t) => {
      const like = `%${t.toLowerCase()}%`;
      return [like, like, like, like];
    });
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
    const conds: string[] = [];
    const params: string[] = [];
    if (opts.artist) { conds.push("lower(artist) LIKE ?"); params.push(`%${opts.artist.toLowerCase()}%`); }
    if (opts.album) { conds.push("lower(album) LIKE ?"); params.push(`%${opts.album.toLowerCase()}%`); }
    if (opts.title) {
      conds.push("(lower(title) LIKE ? OR lower(filename) LIKE ?)");
      params.push(`%${opts.title.toLowerCase()}%`, `%${opts.title.toLowerCase()}%`);
    }
    if (!conds.length) return [];
    return this.db.query(`SELECT * FROM songs WHERE ${conds.join(" AND ")} LIMIT ?`)
      .all(...params, opts.limit ?? 100) as SongRow[];
  }

  albums(): { album: string; artist: string; count: number }[] {
    return this.db.query(
      `SELECT album, artist, COUNT(*) AS count FROM songs WHERE album != '' GROUP BY album, artist ORDER BY count DESC`,
    ).all() as { album: string; artist: string; count: number }[];
  }

  randomPick(limit: number): SongRow[] {
    return this.db.query("SELECT * FROM songs ORDER BY RANDOM() LIMIT ?").all(limit) as SongRow[];
  }
}
