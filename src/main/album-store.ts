/** 文件用途：异步管理画册清单、素材分组和原图复制，限制所有目标路径在当前画册内。 */
import { createReadStream } from 'node:fs';
import { copyFile, link, lstat, mkdir, open, readFile, readdir, realpath, unlink } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AlbumManifest, AlbumSnapshot, AssetEntry, ImportProgress, ImportReport } from '../shared/album';
import { replaceJson } from './json-storage';

export type ImageFormat = 'jpeg' | 'png';
export type ImageValidator = (filePath: string, format: ImageFormat) => Promise<void>;
const supportedExtensions = new Set(['.jpg', '.jpeg', '.png']);

/** 将系统错误转换为中文操作提示，保留未知失败的实际原因。 */
export function describeFileError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === 'EACCES' || code === 'EPERM') return '没有读写权限，或文件正被其他程序占用。';
  if (code === 'ENOENT') return '文件或目录不存在，请刷新素材或重新打开画册。';
  if (code === 'ENOSPC') return '磁盘空间不足。';
  if (code === 'EEXIST') return '同名文件或目录已存在。';
  return error instanceof Error ? error.message : String(error);
}

/** Windows 名称约定：拒绝保留设备名、控制字符、路径分隔符和末尾空格或句点。 */
function assertGroupName(name: unknown): asserts name is string {
  if (typeof name !== 'string' || !name || name.length > 120 || /[<>:"/\\|?*\u0000-\u001f]/u.test(name)
    || /[ .]$/u.test(name) || name === '.' || name === '..'
    || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(name)) {
    throw new Error('分组名称无效：请勿使用 Windows 保留名称、特殊字符或末尾空格、句点（最多 120 字）。');
  }
}

/** 打开时验证正式清单，不采用框架预览数据，不猜测或修复损坏的业务数据。 */
function parseManifest(value: unknown): AlbumManifest {
  if (!value || typeof value !== 'object') throw new Error('画册信息格式错误。');
  const data = value as Record<string, unknown>;
  if (data.formatVersion !== 1) throw new Error('不支持此画册格式版本。');
  if (typeof data.name !== 'string' || !data.name.trim()
    || (data.defaultOrientation !== 'portrait' && data.defaultOrientation !== 'landscape')
    || !Number.isSafeInteger(data.nextPageNumber) || (data.nextPageNumber as number) < 1 || !Array.isArray(data.pages)) {
    throw new Error('画册信息缺少有效的名称、方向、页面列表或编号。');
  }
  const ids = new Set<string>();
  const directories = new Set<string>();
  for (const page of data.pages as unknown[]) {
    if (!page || typeof page !== 'object') throw new Error('画册页面记录格式错误。');
    const item = page as Record<string, unknown>;
    if (typeof item.id !== 'string' || !item.id || ids.has(item.id)
      || typeof item.name !== 'string' || !item.name.trim()
      || typeof item.directoryName !== 'string' || !/^\d{3,}$/u.test(item.directoryName)
      || String(Number(item.directoryName)).padStart(3, '0') !== item.directoryName
      || !Number.isSafeInteger(Number(item.directoryName)) || Number(item.directoryName) < 1
      || Number(item.directoryName) >= (data.nextPageNumber as number) || directories.has(item.directoryName)) {
      throw new Error('画册页面标识或固定目录编号无效。');
    }
    ids.add(item.id);
    directories.add(item.directoryName);
  }
  return data as unknown as AlbumManifest;
}

/** 不跟随目录链接；画册根目录由用户选择后固定为真实路径。 */
async function assertPlainDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('画册目录不能是文件、符号链接或目录联接。');
}

/** 根目录在打开后若被替换成链接或其父路径发生重定向，拒绝继续访问。 */
async function assertAlbumRoot(root: string): Promise<void> {
  await assertPlainDirectory(root);
  if (await realpath(root) !== root) throw new Error('画册目录位置已被更改，请重新打开画册。');
}

/** 优先同卷排他发布；不支持硬链接的磁盘使用排他创建及异步复制，失败仅删除自建目标。 */
export async function publishExclusive(source: string, destination: string): Promise<void> {
  try { await link(source, destination); return; }
  catch (error) {
    if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
  }
  const output = await open(destination, 'wx');
  let completed = false;
  try {
    for await (const chunk of createReadStream(source)) await output.writeFile(chunk as Buffer);
    await output.sync();
    completed = true;
  } finally {
    await output.close();
    if (!completed) await unlink(destination);
  }
}

/** 状态仅在完整读取成功后切换；调用方负责串行化业务操作。 */
export class AlbumStore {
  private current: { root: string; id: string; manifest: AlbumManifest } | null = null;
  private manifestText = '';

  /** 新建只接受空目录；失败只清理本次创建的文件及空目录。 */
  async create(directory: string): Promise<AlbumSnapshot> {
    const root = await realpath(directory);
    await assertPlainDirectory(root);
    if ((await readdir(root)).length) throw new Error('新建画册需要选择空目录，当前目录中已有文件。');
    const manifest: AlbumManifest = {
      formatVersion: 1, name: basename(root), defaultOrientation: 'portrait', pages: [], nextPageNumber: 1
    };
    const createdDirectories: string[] = [];
    const temporary = join(root, `.project-${randomUUID()}.tmp`);
    let temporaryCreated = false;
    try {
      for (const name of ['assets', 'pages', 'cache', 'cache/thumbnails']) {
        const path = join(root, name);
        await mkdir(path);
        createdDirectories.push(path);
      }
      const file = await open(temporary, 'wx');
      temporaryCreated = true;
      try {
        await file.writeFile(JSON.stringify(manifest, null, 2) + '\n', 'utf8');
        await file.sync();
      } finally { await file.close(); }
      // 同目录硬链接发布具有排他性：即使其他程序刚创建 project.json，也不覆盖。
      await publishExclusive(temporary, join(root, 'project.json'));
    } catch (error) {
      // 只删除已记录的空目录；外部新写入的内容不递归删除。
      const { rmdir } = await import('node:fs/promises');
      for (const path of createdDirectories.reverse()) await rmdir(path).catch(() => undefined);
      throw error;
    } finally {
      if (temporaryCreated) await unlink(temporary).catch(() => undefined);
    }
    const scanned = await this.scan(root);
    this.current = { root, id: randomUUID(), manifest };
    this.manifestText = await readFile(join(root, 'project.json'), 'utf8');
    return { id: this.current.id, name: manifest.name, pages: manifest.pages, ...scanned };
  }

  /** 解析、目录检查和扫描均成功后才替换当前会话；无效画册保持原会话可用。 */
  async open(directory: string): Promise<AlbumSnapshot> {
    const root = await realpath(directory);
    await assertPlainDirectory(root);
    const manifestPath = join(root, 'project.json');
    const info = await lstat(manifestPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) throw new Error('画册信息文件无效或过大。');
    let value: unknown;
    let manifestText: string;
    try { manifestText = await readFile(manifestPath, 'utf8'); value = JSON.parse(manifestText); }
    catch (error) {
      if (error instanceof SyntaxError) throw new Error('project.json 内容损坏，无法打开画册。');
      throw error;
    }
    const manifest = parseManifest(value);
    await assertPlainDirectory(join(root, 'assets'));
    await assertPlainDirectory(join(root, 'pages'));
    const scanned = await this.scan(root);
    this.current = { root, id: randomUUID(), manifest };
    this.manifestText = manifestText;
    return { id: this.current.id, name: manifest.name, pages: manifest.pages, ...scanned };
  }

  /** 每个入口校验会话，防止旧画册界面的延迟请求写入新画册。 */
  private session(id?: string): NonNullable<AlbumStore['current']> {
    if (!this.current) throw new Error('请先新建或打开画册。');
    if (id !== undefined && id !== this.current.id) throw new Error('当前画册已切换，请重试。');
    return this.current;
  }

  /** 所有层级逐项 lstat，拒绝绝对路径、..、反斜杠、设备路径和目录链接。 */
  private async assetDirectory(id: string, assetPath: string): Promise<string> {
    const { root } = this.session(id);
    await assertAlbumRoot(root);
    if (typeof assetPath !== 'string' || isAbsolute(assetPath) || assetPath.includes('\\')
      || (assetPath !== '' && assetPath.split('/').some(part => !part || /[ .]$/u.test(part)
        || /[<>:"|?*\u0000-\u001f]/u.test(part)
        || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part)))) {
      throw new Error('素材相对路径无效。');
    }
    const base = join(root, 'assets');
    await assertPlainDirectory(base);
    const destination = resolve(base, assetPath);
    const fromBase = relative(base, destination);
    if (isAbsolute(fromBase) || fromBase === '..' || fromBase.startsWith(`..${sep}`)) throw new Error('素材路径超出当前画册。');
    let cursor = base;
    for (const part of assetPath ? assetPath.split('/') : []) {
      cursor = join(cursor, part);
      await assertPlainDirectory(cursor);
    }
    return destination;
  }

  /** 按目录在前、名称在后排序，只读取目录元数据，不加载图片内容。 */
  private async scan(root: string): Promise<Pick<AlbumSnapshot, 'assets' | 'imageCount' | 'warnings'>> {
    const warnings: string[] = [];
    let imageCount = 0;
    await assertAlbumRoot(root);
    await assertPlainDirectory(join(root, 'assets'));
    /** 逐层扫描普通目录，链接只记录提示，不读取链接指向的目录内容。 */
    async function walk(path: string, prefix: string): Promise<AssetEntry[]> {
      const entries: AssetEntry[] = [];
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const assetPath = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) { warnings.push(`已忽略链接：${assetPath}`); continue; }
        if (entry.isDirectory()) {
          await assertPlainDirectory(join(path, entry.name));
          entries.push({ kind: 'directory', name: entry.name, path: assetPath, children: await walk(join(path, entry.name), assetPath) });
        } else if (entry.isFile() && supportedExtensions.has(extname(entry.name).toLowerCase())) {
          entries.push({ kind: 'image', name: entry.name, path: assetPath });
          imageCount++;
        }
      }
      return entries.sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
    }
    return { assets: await walk(join(root, 'assets'), ''), imageCount, warnings };
  }

  /** 读取实时素材树；扫描失败时调用方保留上次成功的界面状态并报告错误。 */
  async snapshot(id?: string): Promise<AlbumSnapshot> {
    const session = this.session(id);
    return { id: session.id, name: session.manifest.name, pages: session.manifest.pages, ...await this.scan(session.root) };
  }

  /** 仅主进程页面存储使用，返回副本，防止失败操作提前改变已提交的清单。 */
  async project(id: string): Promise<{ root: string; manifest: AlbumManifest }> {
    const session = this.session(id);
    await assertAlbumRoot(session.root);
    return { root: session.root, manifest: structuredClone(session.manifest) };
  }

  /** 错误收尾也可读取已提交页序，不因画册目录暂时不可访问而卡住忙碌状态。 */
  pageReferences(id: string): AlbumManifest['pages'] { return structuredClone(this.session(id).manifest.pages); }

  /** 清单变更校验后原子替换，外部修改或写入失败不更新内存状态。 */
  async commitManifest(id: string, manifest: AlbumManifest): Promise<void> {
    const { root } = await this.project(id);
    parseManifest(manifest);
    this.manifestText = await replaceJson(join(root, 'project.json'), manifest, this.manifestText);
    this.session(id).manifest = structuredClone(manifest);
  }

  /** 素材文件必须位于已校验目录内且为普通 JPEG/PNG，渲染进程不能指定外部源。 */
  async assetFile(id: string, path: string): Promise<string> {
    if (typeof path !== 'string' || path.includes('\\') || !supportedExtensions.has(extname(path).toLowerCase())) throw new Error('素材文件路径无效。');
    const name = basename(path);
    if (/[<>:"|?*\u0000-\u001f]/u.test(name) || /[ .]$/u.test(name)
      || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(name)) throw new Error('素材文件名无效。');
    const directory = await this.assetDirectory(id, dirname(path) === '.' ? '' : dirname(path));
    const file = join(directory, name);
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('素材文件不能是目录或链接。');
    return file;
  }

  /** 只创建固定的可重建素材缓存目录；逐层拒绝链接，兼容未创建缓存的旧画册。 */
  async assetThumbnailDirectory(id: string): Promise<string> {
    const { root } = await this.project(id);
    await assertAlbumRoot(root);
    let directory = root;
    for (const name of ['cache', 'thumbnails', 'assets']) {
      directory = join(directory, name);
      try { await assertPlainDirectory(directory); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        try { await mkdir(directory); }
        catch (creationError) { if ((creationError as NodeJS.ErrnoException).code !== 'EEXIST') throw creationError; }
        await assertPlainDirectory(directory);
      }
    }
    return directory;
  }

  /** 创建指定分组；重名报错而不是合并现有目录。 */
  async createGroup(id: string, parentPath: string, name: string): Promise<void> {
    assertGroupName(name);
    await mkdir(join(await this.assetDirectory(id, parentPath), name));
  }

  /** 复制到临时文件并校验，排他发布到目标名称；单项失败继续处理其余图片。 */
  async importImages(id: string, targetPath: string, sources: string[], validate: ImageValidator,
    progress: (value: ImportProgress) => void): Promise<ImportReport> {
    await this.assetDirectory(id, targetPath);
    const report: ImportReport = { succeeded: [], failed: [], warnings: [] };
    for (const [index, source] of sources.entries()) {
      const sourceName = basename(source);
      let temporary: string | null = null;
      let temporaryOwned = false;
      progress({ completed: index, total: sources.length, fileName: sourceName,
        succeeded: report.succeeded.length, failed: report.failed.length });
      try {
        const extension = extname(sourceName);
        if (!supportedExtensions.has(extension.toLowerCase())) throw new Error('仅支持 JPEG（.jpg、.jpeg）和 PNG 图片。');
        const sourceInfo = await lstat(source);
        if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error('请选择普通图片文件，不能导入目录或符号链接。');
        const destination = await this.assetDirectory(id, targetPath);
        temporary = join(destination, `.album-import-${randomUUID()}.tmp`);
        // 先排他占有临时文件，复制中途失败也能准确清理本次副本。
        const reservation = await open(temporary, 'wx');
        temporaryOwned = true;
        await reservation.close();
        await copyFile(source, temporary);
        // 根据文件头确认实际格式，改后缀的文件不能作为格式转换导入。
        const file = await open(temporary, 'r');
        const header = Buffer.alloc(8);
        try { await file.read(header, 0, 8, 0); } finally { await file.close(); }
        const format: ImageFormat = extension.toLowerCase() === '.png' ? 'png' : 'jpeg';
        if (format === 'png' ? !header.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          : header[0] !== 0xff || header[1] !== 0xd8 || header[2] !== 0xff) throw new Error('图片内容与扩展名不符，或文件已损坏。');
        await validate(temporary, format);
        await this.assetDirectory(id, targetPath);
        const stem = sourceName.slice(0, -extension.length);
        let suffix = 0;
        let savedName: string;
        while (true) {
          savedName = `${stem}${suffix ? ` (${suffix})` : ''}${extension}`;
          try {
            // 硬链接是同卷的排他发布操作；同名文件、目录或链接均不会被覆盖。
            await publishExclusive(temporary, join(destination, savedName));
            break;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            suffix++;
          }
        }
        report.succeeded.push({ sourceName, savedPath: targetPath ? `${targetPath}/${savedName}` : savedName });
      } catch (error) {
        report.failed.push({ sourceName, reason: describeFileError(error) });
      } finally {
        if (temporary && temporaryOwned) {
          try { await unlink(temporary); }
          catch (error) { report.warnings.push(`${sourceName} 的临时文件清理失败：${describeFileError(error)}`); }
        }
        progress({ completed: index + 1, total: sources.length, fileName: sourceName,
          succeeded: report.succeeded.length, failed: report.failed.length });
      }
    }
    return report;
  }
}
