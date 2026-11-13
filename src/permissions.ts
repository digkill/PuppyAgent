import { realpath, lstat } from 'node:fs/promises';
import { dirname, join, relative, resolve, isAbsolute, sep } from 'node:path';
import type { PermissionMode } from './types.ts';

export type PermissionRequest = { action: 'read' | 'write' | 'shell' | 'memory'; target: string; detail?: string };
export type Approver = (request: PermissionRequest) => Promise<boolean>;
export function within(path: string, root: string): boolean {
  const rel = relative(root, path);
  return !rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}
// Resolve the nearest existing ancestor as well as the target itself, including dangling symlinks.
export async function canonicalPath(path: string): Promise<string> {
  const absolute = resolve(path);
  try { return await realpath(absolute); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (await lstat(absolute).catch(() => null)) throw new Error(`Dangling symlink: ${absolute}`);
    const parent = dirname(absolute);
    if (parent === absolute) throw error;
    return join(await canonicalPath(parent), absolute.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
  }
}
export class Permissions {
  mode: PermissionMode;
  workspace: string;
  tmpDir: string;
  approve: Approver;
  constructor(mode: PermissionMode, workspace: string, tmpDir: string, approve: Approver) {
    this.mode = mode; this.workspace = workspace; this.tmpDir = tmpDir; this.approve = approve;
  }
  async check(req: PermissionRequest): Promise<void> {
    if (this.mode === 'full-access') return;
    if (this.mode === 'read-only' && req.action !== 'read') throw new Error(`Read-only mode denies ${req.action}.`);
    if (req.action === 'read' || req.action === 'write') {
      const target = await canonicalPath(req.target);
      const roots = await Promise.all([canonicalPath(this.workspace), canonicalPath(this.tmpDir)]);
      const local = roots.some(root => within(target, root));
      if (req.action === 'read' && local) return;
      if (req.action === 'write' && local && this.mode === 'workspace-write') return;
      if (this.mode === 'read-only') throw new Error(`Read-only mode cannot access outside workspace: ${target}`);
      req = { ...req, target };
    }
    if (!(await this.approve(req))) throw new Error(`Permission denied: ${req.action} ${req.target}`);
  }
}
