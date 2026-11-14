import { chmod, lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

/** Remove an owned runtime tree, including read-only Go module cache directories.
 * Directory symlinks are removed by rm and are never traversed or chmodded.
 */
export async function cleanupRuntime(path: string): Promise<void> {
  try { await rm(path, { recursive: true, force: true }); }
  catch (error) {
    if (!['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code || '')) throw error;
    async function writableDirectories(directory: string): Promise<void> {
      const info = await lstat(directory).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      });
      if (!info?.isDirectory() || info.isSymbolicLink()) return;
      await chmod(directory, (info.mode & 0o777) | 0o700);
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.isSymbolicLink()) await writableDirectories(join(directory, entry.name));
      }
    }
    await writableDirectories(path);
    await rm(path, { recursive: true, force: true });
  }
}
