import { lstat, mkdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Export only beneath the configured root; never follow user-selected symlinks. */
export async function writeExport(root: string, directory: string, filename: string, data: string | Buffer): Promise<string> {
  if (!filename || filename === '.' || filename === '..' || /[/\\\0]/.test(filename)
    || isAbsolute(directory) || directory.includes('\\') || directory.includes('\0')) throw new Error('Invalid export path');
  const base = resolve(root);
  const destination = resolve(base, directory);
  const inside = relative(base, destination);
  if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error('Export must stay inside its configured directory');
  await mkdir(base, { recursive: true });
  const canonical = await realpath(base);
  let parent = canonical;
  for (const part of inside.split(sep).filter(Boolean)) {
    parent = join(parent, part);
    try { await mkdir(parent); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const info = await lstat(parent);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Export directories must not be symbolic links');
  }
  const target = join(parent, filename);
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('Export target must be a regular file');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  // Replace the directory entry, rather than truncating a possibly linked file.
  const temporary = join(parent, `.petroglyphs-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, data, { flag: 'wx', mode: 0o600 });
    await rename(temporary, target);
  } finally { await unlink(temporary).catch(() => {}); }
  return target;
}
