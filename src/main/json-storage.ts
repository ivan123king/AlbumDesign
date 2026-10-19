/** 文件用途：以同目录临时文件替换 JSON，检测外部修改，写入失败保留原有有效文件。 */
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** existing 为原始文本；正式文件必须仍是普通文件且内容相同，否则拒绝覆盖。 */
export async function replaceJson(path: string, value: unknown, existing: string): Promise<string> {
  const text = JSON.stringify(value, null, 2) + '\n';
  const temporary = join(dirname(path), `.json-${randomUUID()}.tmp`);
  const handle = await open(temporary, 'wx');
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || await readFile(path, 'utf8') !== existing) {
      throw new Error('文件已被外部修改，请保留当前画册并重新打开后核对；未覆盖磁盘内容。');
    }
    await rename(temporary, path);
    return text;
  } finally { await unlink(temporary).catch(() => undefined); }
}
