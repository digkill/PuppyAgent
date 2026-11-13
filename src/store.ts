import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { Language, Message, PermissionMode, Pricing, RequestMetrics, RequestRecord, Session, StoredMessage, TaskRun } from './types.ts';

export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    if (Number(this.db.prepare('PRAGMA user_version').get()!.user_version) > 3) {
      this.db.close();
      throw new Error('Database schema is newer than this version of Puppy Agent.');
    }
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA temp_store=MEMORY;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, parentId TEXT REFERENCES sessions(id), title TEXT NOT NULL,
        cwd TEXT NOT NULL, workspace TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
        permissionMode TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'idle',
        summary TEXT NOT NULL DEFAULT '', summaryThrough INTEGER NOT NULL DEFAULT 0,
        inputTokens INTEGER NOT NULL DEFAULT 0, outputTokens INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, sessionId TEXT NOT NULL REFERENCES sessions(id),
        role TEXT NOT NULL, content TEXT NOT NULL, createdAt TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_session ON messages(sessionId,id);
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, sessionId TEXT NOT NULL REFERENCES sessions(id),
        type TEXT NOT NULL, detail TEXT NOT NULL, createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memories (
        scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updatedAt TEXT NOT NULL,
        PRIMARY KEY(scope,key)
      );
      CREATE TABLE IF NOT EXISTS leases (
        sessionId TEXT PRIMARY KEY REFERENCES sessions(id), owner TEXT NOT NULL, expires INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_runs (
        id TEXT PRIMARY KEY, sessionId TEXT NOT NULL REFERENCES sessions(id), status TEXT NOT NULL,
        creditLimit REAL, createdAt TEXT NOT NULL, finishedAt TEXT
      );
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY, runId TEXT NOT NULL REFERENCES task_runs(id), sessionId TEXT NOT NULL REFERENCES sessions(id),
        purpose TEXT NOT NULL, provider TEXT NOT NULL, requestedModel TEXT NOT NULL, status TEXT NOT NULL,
        metrics TEXT, pricing TEXT, startedAt TEXT NOT NULL, finishedAt TEXT
      );
      CREATE INDEX IF NOT EXISTS requests_session ON requests(sessionId,startedAt);
      CREATE INDEX IF NOT EXISTS requests_run ON requests(runId);
    `);
    if (!this.db.prepare('PRAGMA table_info(sessions)').all().some(column => column.name === 'language')) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN language TEXT NOT NULL DEFAULT 'en'");
    }
    this.db.exec('PRAGMA user_version=3');
  }
  create(input: { cwd: string; workspace?: string; provider: string; model: string; permissionMode: PermissionMode; language?: Language; parentId?: string; title?: string }): Session {
    const now = new Date().toISOString();
    const session: Session = {
      language: input.language || 'en',
      id: randomUUID(), parentId: input.parentId || null, title: input.title || 'New puppy adventure',
      cwd: input.cwd, workspace: input.workspace || input.cwd, provider: input.provider,
      model: input.model, permissionMode: input.permissionMode, status: 'idle', summary: '',
      summaryThrough: 0, inputTokens: 0, outputTokens: 0, createdAt: now, updatedAt: now,
    };
    const entries = Object.entries(session);
    this.db.prepare(`INSERT INTO sessions (${entries.map(([key]) => key).join(',')}) VALUES (${entries.map(() => '?').join(',')})`).run(...entries.map(([, value]) => value));
    return session;
  }
  get(id: string): Session {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id=?').get(id);
    if (!row) throw new Error(`Session not found: ${id}`);
    return row as unknown as Session;
  }
  list(cwd?: string): Session[] {
    return (cwd
      ? this.db.prepare('SELECT * FROM sessions WHERE parentId IS NULL AND cwd=? ORDER BY updatedAt DESC,rowid DESC LIMIT 100').all(cwd)
      : this.db.prepare('SELECT * FROM sessions WHERE parentId IS NULL ORDER BY updatedAt DESC,rowid DESC LIMIT 100').all()) as unknown as Session[];
  }
  children(parentId: string): Session[] {
    return this.db.prepare('SELECT * FROM sessions WHERE parentId=? ORDER BY createdAt DESC LIMIT 100').all(parentId) as unknown as Session[];
  }
  isLeased(sessionId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM leases WHERE sessionId=? AND expires>?').get(sessionId, Date.now()));
  }
  update(id: string, patch: Partial<Pick<Session, 'cwd' | 'permissionMode' | 'status' | 'title' | 'summary' | 'summaryThrough' | 'language'>>): void {
    const allowed = ['cwd', 'permissionMode', 'status', 'title', 'summary', 'summaryThrough', 'language'];
    const entries = Object.entries(patch);
    if (entries.some(([key]) => !allowed.includes(key))) throw new Error('Unsupported session field.');
    if (!entries.length) return;
    this.db.prepare(`UPDATE sessions SET ${entries.map(([k]) => `${k}=?`).join(',')},updatedAt=? WHERE id=?`)
      .run(...entries.map(([, v]) => v), new Date().toISOString(), id);
  }
  append(sessionId: string, message: Message): StoredMessage {
    const result = this.db.prepare('INSERT INTO messages (sessionId,role,content,createdAt) VALUES (?,?,?,?)')
      .run(sessionId, message.role, JSON.stringify(message.content), new Date().toISOString());
    this.db.prepare('UPDATE sessions SET updatedAt=? WHERE id=?').run(new Date().toISOString(), sessionId);
    return { ...message, sessionId, id: Number(result.lastInsertRowid) };
  }
  messages(sessionId: string, after = 0): StoredMessage[] {
    return this.db.prepare('SELECT * FROM messages WHERE sessionId=? AND id>? ORDER BY id').all(sessionId, after)
      .map(row => ({ id: Number(row.id), sessionId, role: row.role, content: JSON.parse(String(row.content)) })) as StoredMessage[];
  }
  event(sessionId: string, type: string, detail: unknown): void {
    this.db.prepare('INSERT INTO events (sessionId,type,detail,createdAt) VALUES (?,?,?,?)')
      .run(sessionId, type, JSON.stringify(detail), new Date().toISOString());
  }
  usage(id: string, input: number, output: number): void {
    this.db.prepare('UPDATE sessions SET inputTokens=inputTokens+?,outputTokens=outputTokens+? WHERE id=?').run(input, output, id);
  }
  startTask(sessionId: string, creditLimit?: number): TaskRun {
    const task: TaskRun = { id: randomUUID(), sessionId, status: 'running', creditLimit: creditLimit ?? null, createdAt: new Date().toISOString(), finishedAt: null };
    this.db.prepare('INSERT INTO task_runs VALUES (?,?,?,?,?,?)').run(task.id, sessionId, task.status, task.creditLimit, task.createdAt, null);
    return task;
  }
  latestTask(sessionId: string, unfinished = false): TaskRun | undefined {
    return this.db.prepare(`SELECT * FROM task_runs WHERE sessionId=? ${unfinished ? "AND status!='completed'" : ''} ORDER BY rowid DESC LIMIT 1`).get(sessionId) as TaskRun | undefined;
  }
  finishTask(id: string, status: string): void {
    this.db.prepare('UPDATE task_runs SET status=?,finishedAt=? WHERE id=?').run(status, new Date().toISOString(), id);
  }
  startRequest(runId: string, session: Session, purpose: string, pricing?: Pricing): string {
    const id = randomUUID();
    this.db.prepare('INSERT INTO requests VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id, runId, session.id, purpose, session.provider, session.model, 'pending', null, pricing ? JSON.stringify(pricing) : null, new Date().toISOString(), null);
    return id;
  }
  finishRequest(id: string, metrics: RequestMetrics, status: 'completed' | 'failed'): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare("SELECT sessionId FROM requests WHERE id=? AND status='pending'").get(id);
      if (!row) throw new Error('Request was already committed or does not exist.');
      this.db.prepare('UPDATE requests SET metrics=?,status=?,finishedAt=? WHERE id=?').run(JSON.stringify(metrics), status, new Date().toISOString(), id);
      this.usage(String(row.sessionId), metrics.usage.inputTokens ?? ((metrics.usage.uncachedInputTokens ?? 0) + (metrics.usage.cacheReadInputTokens ?? 0) + (metrics.usage.cacheCreationInputTokens ?? 0)), metrics.usage.outputTokens ?? 0);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  requests(sessionId: string, runId?: string): RequestRecord[] {
    const rows = runId
      ? this.db.prepare('SELECT * FROM requests WHERE runId=? ORDER BY rowid').all(runId)
      : this.db.prepare(`WITH RECURSIVE pack(id) AS (SELECT id FROM sessions WHERE id=? UNION ALL SELECT s.id FROM sessions s JOIN pack p ON s.parentId=p.id)
        SELECT * FROM requests WHERE sessionId IN (SELECT id FROM pack) ORDER BY rowid`).all(sessionId);
    return rows.map(r => ({ ...r, metrics: r.metrics === null ? null : JSON.parse(String(r.metrics)), pricing: r.pricing === null ? null : JSON.parse(String(r.pricing)) })) as unknown as RequestRecord[];
  }
  memory(scope: string): { key: string; value: string }[] {
    return this.db.prepare('SELECT key,value FROM memories WHERE scope=? ORDER BY key').all(scope) as { key: string; value: string }[];
  }
  remember(scope: string, key: string, value: string): void {
    if (!key.trim() || key.length > 200 || value.length > 12000) throw new Error('Memory key/value too large or empty.');
    this.db.prepare(`INSERT INTO memories VALUES (?,?,?,?) ON CONFLICT(scope,key) DO UPDATE SET value=excluded.value,updatedAt=excluded.updatedAt`)
      .run(scope, key, value, new Date().toISOString());
  }
  forget(scope: string, key: string): void {
    this.db.prepare('DELETE FROM memories WHERE scope=? AND key=?').run(scope, key);
  }
  acquire(id: string, owner: string): void {
    const result = this.db.prepare(`INSERT INTO leases VALUES (?,?,?) ON CONFLICT(sessionId) DO UPDATE SET
      owner=excluded.owner,expires=excluded.expires WHERE leases.expires<? OR leases.owner=?`)
      .run(id, owner, Date.now() + 60000, Date.now(), owner);
    if (!result.changes) throw new Error('This session is already running in another process.');
  }
  renew(id: string, owner: string): void {
    if (!this.db.prepare('UPDATE leases SET expires=? WHERE sessionId=? AND owner=?').run(Date.now() + 60000, id, owner).changes) throw new Error('Session lease lost.');
  }
  release(id: string, owner: string): void {
    this.db.prepare('DELETE FROM leases WHERE sessionId=? AND owner=?').run(id, owner);
  }
  close(): void { this.db.close(); }
}
