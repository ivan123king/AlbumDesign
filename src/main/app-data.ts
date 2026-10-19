/** 文件用途：保存当前用户的软件设置与使用状态，隔离画册文件并保护异常或较新版本配置。 */
import { mkdir, lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { publishExclusive, describeFileError } from './album-store';
import { replaceJson } from './json-storage';

/** 配置版本独立于画册格式；后续软件设置在此扩展。 */
interface SoftwareSettings { formatVersion: 1; reopenLastAlbum: boolean }
interface SoftwareState {
  formatVersion: 1;
  lastAlbum: { directory: string; name: string; openedAt: string } | null;
}
type DataFile = 'settings' | 'state';

/** 主进程控制器负责串行调用；失败抛出中文原因，调用方应保留已打开的画册。 */
export class AppDataStore {
  private settings: SoftwareSettings = { formatVersion: 1, reopenLastAlbum: true };
  private state: SoftwareState = { formatVersion: 1, lastAlbum: null };
  private originals: Record<DataFile, string | null> = { settings: null, state: null };
  private blocked = new Set<DataFile>();
  readonly warnings: string[] = [];

  constructor(readonly directory: string) {}

  get reopenLastAlbum(): boolean { return this.settings.reopenLastAlbum; }
  get lastAlbum(): Readonly<NonNullable<SoftwareState['lastAlbum']>> | null { return this.state.lastAlbum; }

  /** 缺失使用默认值；损坏文件先留存副本，未知版本与读取失败的文件禁止覆盖。 */
  async load(): Promise<void> {
    try { await mkdir(this.directory, { recursive: true }); }
    catch (error) {
      this.blocked = new Set(['settings', 'state']);
      this.warnings.push(`无法访问软件数据目录：${describeFileError(error)}`);
      return;
    }
    for (const name of ['settings', 'state'] as const) {
      const path = join(this.directory, `${name}.json`);
      let text: string;
      try {
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024) throw new Error('软件数据文件类型或大小无效。');
        text = await readFile(path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        this.blocked.add(name);
        this.warnings.push(`${name}.json 无法读取，已使用默认值并保留原文件：${describeFileError(error)}`);
        continue;
      }
      let value: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        value = parsed as Record<string, unknown>;
        // 未来版本交给对应版本的软件处理，绝不降级覆盖。
        if (Number.isSafeInteger(value.formatVersion) && Number(value.formatVersion) > 1) {
          this.blocked.add(name);
          this.warnings.push(`${name}.json 来自较新版本，已使用默认值并保留原文件。`);
          continue;
        }
        if (value.formatVersion !== 1) throw new Error();
        if (name === 'settings') {
          if (typeof value.reopenLastAlbum !== 'boolean') throw new Error();
          this.settings = value as unknown as SoftwareSettings;
        } else {
          const last = value.lastAlbum as Partial<NonNullable<SoftwareState['lastAlbum']>> | null;
          if (last !== null && (!last || typeof last.directory !== 'string' || !isAbsolute(last.directory)
            || last.directory.includes('\0') || typeof last.name !== 'string' || !last.name.trim()
            || typeof last.openedAt !== 'string' || !Number.isFinite(Date.parse(last.openedAt)))) throw new Error();
          this.state = value as unknown as SoftwareState;
        }
        this.originals[name] = text;
      } catch {
        const backup = `${name}.corrupt-${randomUUID()}.json`;
        try {
          await rename(path, join(this.directory, backup));
          this.warnings.push(`${name}.json 损坏，已使用默认值；原文件保留为 ${backup}。`);
        } catch (error) {
          this.blocked.add(name);
          this.warnings.push(`${name}.json 损坏，无法留存副本，已保留原文件并使用默认值：${describeFileError(error)}`);
        }
      }
    }
  }

  /** 异步写临时文件并提交；首次排他创建，已有文件复用外部修改检查，失败不更新内存。 */
  private async write(name: DataFile, value: SoftwareSettings | SoftwareState): Promise<void> {
    if (this.blocked.has(name)) throw new Error(`${name}.json 当前受保护，未覆盖原文件。`);
    const path = join(this.directory, `${name}.json`);
    const existing = this.originals[name];
    if (existing !== null) {
      this.originals[name] = await replaceJson(path, value, existing);
      return;
    }
    const text = JSON.stringify(value, null, 2) + '\n';
    const temporary = join(this.directory, `.data-${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx');
    try {
      try { await handle.writeFile(text, 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
      await publishExclusive(temporary, path);
      this.originals[name] = text;
    } finally { await unlink(temporary).catch(() => undefined); }
  }

  /** 设置只有落盘成功后才生效；失败时菜单继续显示原值。 */
  async setReopenLastAlbum(enabled: boolean): Promise<void> {
    const next = { ...this.settings, reopenLastAlbum: enabled };
    await this.write('settings', next);
    this.settings = next;
  }

  /** 只记录完整打开成功后的真实绝对目录，不写入画册自身，也不保存未提交草稿。 */
  async rememberAlbum(directory: string, name: string): Promise<void> {
    const next: SoftwareState = { ...this.state, lastAlbum: { directory, name, openedAt: new Date().toISOString() } };
    await this.write('state', next);
    this.state = next;
  }
}
