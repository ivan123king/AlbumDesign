/** 文件用途：管理正式页面、单页编辑草稿、独立图片副本及可回滚的普通文件操作。 */
import { copyFile, lstat, mkdir, open, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AlbumPageReference } from '../shared/album';
import type { CanvasDocument, CanvasSnapshot, ImageGeometry, ImageObject } from '../shared/canvas';
import { fitImage } from '../shared/canvas';
import type { Orientation } from '../shared/framework';
import { AlbumStore, publishExclusive } from './album-store';
import { replaceJson } from './json-storage';

export type InspectImage = (path: string, format: 'jpeg' | 'png') => Promise<{ width: number; height: number }>;

/** 方向仅有两种；来自 IPC 的值必须运行时检查。 */
export function assertOrientation(value: unknown): asserts value is Orientation {
  if (value !== 'portrait' && value !== 'landscape') throw new Error('画布方向无效。');
}

/** 显示名称与文件名无关，可以使用中文和标点，但不能留空或无限增长。 */
function assertPageName(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 120 || /[\u0000-\u001f]/u.test(value)) throw new Error('画布名称需为 1～120 个可见字符。');
}

/** 正式文件只接受已知的图片模型；编号、对象 ID、叠层分别校验。 */
export function parseCanvas(value: unknown): CanvasDocument {
  if (!value || typeof value !== 'object') throw new Error('画布文件格式错误。');
  const data = value as CanvasDocument;
  assertOrientation(data.orientation);
  if (data.formatVersion !== 1 || data.widthMm !== 210 || data.heightMm !== 297
    || !Number.isSafeInteger(data.nextImageNumber) || data.nextImageNumber < 1 || !Array.isArray(data.objects)) throw new Error('画布格式、A4 尺寸或图片计数无效。');
  const ids = new Set<string>();
  const files = new Set<string>();
  const layers = new Set<number>();
  for (const item of data.objects) {
    if (!item || item.kind !== 'image' || typeof item.id !== 'string' || !item.id || ids.has(item.id)
      || typeof item.fileName !== 'string' || !/^\d{3,}\.(?:jpg|jpeg|png)$/iu.test(item.fileName)
      || files.has(item.fileName.toLowerCase()) || Number(item.fileName.split('.')[0]) < 1
      || Number(item.fileName.split('.')[0]) >= data.nextImageNumber
      || typeof item.sourceName !== 'string' || item.sourceName.length > 255
      || ![item.xMm, item.yMm, item.widthMm, item.heightMm].every(Number.isFinite)
      || Math.abs(item.xMm) > 100000 || Math.abs(item.yMm) > 100000 || item.widthMm <= 0 || item.heightMm <= 0
      || item.widthMm > 100000 || item.heightMm > 100000 || ![0, 90, 180, 270].includes(item.rotation)
      || !Number.isSafeInteger(item.zIndex) || item.zIndex < 0 || layers.has(item.zIndex)) throw new Error('画布图片记录包含无效路径、坐标、编号或叠层。');
    ids.add(item.id); files.add(item.fileName.toLowerCase()); layers.add(item.zIndex);
  }
  return data;
}

/** 文件目录不接受链接，避免页面写入、读取和递归删除越出当前画册。 */
async function plainDirectory(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('页面或缓存目录不是普通目录。');
}

/** 删除前逐层检查，发现任何链接即停止，不递归进入外部位置。 */
async function assertDeletableDirectory(path: string): Promise<void> {
  await plainDirectory(path);
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('页面或缓存中含有链接，请先在文件管理器中核对。');
    if (entry.isDirectory()) await assertDeletableDirectory(join(path, entry.name));
  }
}

/** 只缓存当前页；位置、尺寸和视角草稿需要手动保存，结构性文件操作在无草稿时提交。 */
export class PageStore {
  private active: { albumId: string; pageId: string; document: CanvasDocument; saved: CanvasDocument; text: string; warnings: string[] } | null = null;

  constructor(private readonly albums: AlbumStore, private readonly inspect: InspectImage) {}

  /** 返回独立快照，不把图片二进制或磁盘绝对路径发送到界面。 */
  snapshot(): CanvasSnapshot | null {
    if (!this.active) return null;
    return { pageId: this.active.pageId, document: structuredClone(this.active.document), dirty: this.dirty,
      warnings: [...this.active.warnings] };
  }

  get dirty(): boolean { return !!this.active && JSON.stringify(this.active.document) !== JSON.stringify(this.active.saved); }

  /** 仅放弃尚未提交的位置、尺寸和方向，不删除已完成的图片导入或页面操作。 */
  discard(): void { if (this.active) this.active.document = structuredClone(this.active.saved); }

  /** 根据清单中的稳定 ID 查页，拒绝界面直接提供目录编号或磁盘路径。 */
  private async pageDirectory(albumId: string, pageId: string): Promise<{ path: string; reference: AlbumPageReference }> {
    const { root, manifest } = await this.albums.project(albumId);
    const reference = manifest.pages.find(page => page.id === pageId);
    if (!reference) throw new Error('画布不存在或当前画册已切换。');
    await plainDirectory(join(root, 'pages'));
    const path = join(root, 'pages', reference.directoryName);
    await plainDirectory(path);
    return { path, reference };
  }

  /** 每次写入或草稿更新都检查当前页 ID，避免延迟事件改动刚切换的页面。 */
  private current(albumId: string, pageId: string): NonNullable<PageStore['active']> {
    if (!this.active || this.active.albumId !== albumId || this.active.pageId !== pageId) throw new Error('当前画布已切换，请重试。');
    return this.active;
  }

  /** 校验单个页面文件，缺失图片保留对象并提示，绝不静默删除有效排版。 */
  async load(albumId: string, pageId: string): Promise<void> {
    const { path } = await this.pageDirectory(albumId, pageId);
    const file = join(path, 'canvas.json');
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024) throw new Error('画布信息文件无效或过大。');
    const text = await readFile(file, 'utf8');
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new Error('canvas.json 已损坏，未覆盖原有数据。'); }
    const document = parseCanvas(value);
    const warnings: string[] = [];
    for (const object of document.objects) {
      try { await this.imagePath(albumId, pageId, object.id, document); }
      catch (error) { warnings.push(`${object.fileName} 无法加载：${error instanceof Error ? error.message : String(error)}`); }
    }
    this.active = { albumId, pageId, document, saved: structuredClone(document), text, warnings };
  }

  /** 页面编号先持久化预留，失败产生的空号也不复用；目录成功后再加入页序。 */
  async create(albumId: string, name: string, orientation: Orientation): Promise<void> {
    assertPageName(name); assertOrientation(orientation);
    const { root, manifest } = await this.albums.project(albumId);
    await plainDirectory(join(root, 'pages'));
    const number = manifest.nextPageNumber++;
    await this.albums.commitManifest(albumId, manifest);
    const reference = { id: randomUUID(), name: name.trim(), directoryName: String(number).padStart(3, '0') };
    const path = join(root, 'pages', reference.directoryName);
    await mkdir(path);
    try {
      const document: CanvasDocument = { formatVersion: 1, widthMm: 210, heightMm: 297, orientation, nextImageNumber: 1, objects: [] };
      await writeFile(join(path, 'canvas.json'), JSON.stringify(document, null, 2) + '\n', { flag: 'wx' });
      manifest.pages.push(reference);
      await this.albums.commitManifest(albumId, manifest);
    } catch (error) {
      await assertDeletableDirectory(path);
      await rm(path, { recursive: true });
      throw error;
    }
    await this.load(albumId, reference.id);
  }

  /** 名称只写工程清单，目录编号不变。 */
  async rename(albumId: string, pageId: string, name: string): Promise<void> {
    assertPageName(name);
    const { manifest } = await this.albums.project(albumId);
    const page = manifest.pages.find(item => item.id === pageId);
    if (!page) throw new Error('画布不存在。');
    page.name = name.trim();
    await this.albums.commitManifest(albumId, manifest);
  }

  /** 上下移动只交换清单数组中的页序，不移动或重命名目录。 */
  async reorder(albumId: string, pageId: string, direction: -1 | 1): Promise<void> {
    if (direction !== -1 && direction !== 1) throw new Error('页序移动方向无效。');
    const { manifest } = await this.albums.project(albumId);
    const index = manifest.pages.findIndex(item => item.id === pageId);
    if (index < 0) throw new Error('画布不存在。');
    const target = index + direction;
    if (target < 0 || target >= manifest.pages.length) return;
    [manifest.pages[index], manifest.pages[target]] = [manifest.pages[target]!, manifest.pages[index]!];
    await this.albums.commitManifest(albumId, manifest);
  }

  /** 删除先隔离页面目录，清单失败则放回；提交成功后真实删除并清理该页缓存。 */
  async delete(albumId: string, pageId: string): Promise<void> {
    const { path, reference } = await this.pageDirectory(albumId, pageId);
    const { root, manifest } = await this.albums.project(albumId);
    await assertDeletableDirectory(path);
    const cache = join(root, 'cache', 'thumbnails', reference.directoryName);
    let hasCache = false;
    try {
      await lstat(cache); hasCache = true;
      await plainDirectory(join(root, 'cache')); await plainDirectory(join(root, 'cache', 'thumbnails'));
      await assertDeletableDirectory(cache);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const isolated = join(root, 'pages', `.delete-${randomUUID()}`);
    await rename(path, isolated);
    manifest.pages = manifest.pages.filter(item => item.id !== pageId);
    try { await this.albums.commitManifest(albumId, manifest); }
    catch (error) { await rename(isolated, path); throw error; }
    this.active = null;
    await rm(isolated, { recursive: true });
    if (hasCache) await rm(cache, { recursive: true });
  }

  /** 保存时校验原始文本未被其他程序修改，成功后才清除未保存状态。 */
  async save(): Promise<void> {
    if (!this.active || !this.dirty) return;
    const active = this.active;
    const { path } = await this.pageDirectory(active.albumId, active.pageId);
    parseCanvas(active.document);
    const text = await replaceJson(join(path, 'canvas.json'), active.document, active.text);
    active.text = text;
    active.saved = structuredClone(active.document);
  }

  /** 内部结构变更提交，失败恢复原草稿，计数预留等已经成功的提交保留。 */
  private async commit(document: CanvasDocument): Promise<void> {
    const active = this.active!;
    const previous = active.document;
    active.document = document;
    try { await this.save(); } catch (error) { active.document = previous; throw error; }
  }

  /** 先复制原图到本页临时文件并后台解码，再独立发布、写入对象，保留原文件后缀。 */
  async addImage(albumId: string, pageId: string, assetPath: string): Promise<void> {
    const active = this.current(albumId, pageId);
    if (this.dirty) throw new Error('请先保存或放弃当前画布修改。');
    const source = await this.albums.assetFile(albumId, assetPath);
    const { path } = await this.pageDirectory(albumId, pageId);
    const document = structuredClone(active.document);
    const number = document.nextImageNumber++;
    await this.commit(document);
    const extension = extname(source);
    const fileName = `${String(number).padStart(3, '0')}${extension}`;
    const temporary = join(path, `.image-${randomUUID()}.tmp`);
    const target = join(path, fileName);
    const reservation = await open(temporary, 'wx');
    await reservation.close();
    let published = false;
    try {
      await copyFile(source, temporary);
      const dimensions = await this.inspect(temporary, extension.toLowerCase() === '.png' ? 'png' : 'jpeg');
      if (![dimensions.width, dimensions.height].every(value => Number.isFinite(value) && value > 0)) throw new Error('图片尺寸无效。');
      await this.pageDirectory(albumId, pageId);
      await publishExclusive(temporary, target); published = true;
      const object: ImageObject = { id: randomUUID(), kind: 'image', fileName, sourceName: basename(source),
        ...fitImage(dimensions.width, dimensions.height, document.orientation),
        zIndex: Math.max(-1, ...document.objects.map(item => item.zIndex)) + 1 };
      await this.commit({ ...document, objects: [...document.objects, object] });
    } catch (error) {
      if (published) await unlink(target);
      throw error;
    } finally { await unlink(temporary).catch(() => undefined); }
  }

  /** 移动只更新毫米草稿，允许越出画布；正式保存保持原图及对象尺寸不变。 */
  move(albumId: string, pageId: string, objectId: string, xMm: number, yMm: number): void {
    const active = this.current(albumId, pageId);
    if (![xMm, yMm].every(value => Number.isFinite(value) && Math.abs(value) <= 100000)) throw new Error('图片位置无效。');
    const object = active.document.objects.find(item => item.id === objectId);
    if (!object) throw new Error('图片对象不存在。');
    object.xMm = xMm; object.yMm = yMm;
  }

  /** 尺寸与锚点位置一次性更新到草稿，校验失败不部分更新；原图、角度、叠层及编号不变。 */
  resize(albumId: string, pageId: string, objectId: string, geometry: ImageGeometry): void {
    const active = this.current(albumId, pageId);
    if (!geometry || ![geometry.xMm, geometry.yMm, geometry.widthMm, geometry.heightMm].every(Number.isFinite)
      || Math.abs(geometry.xMm) > 100000 || Math.abs(geometry.yMm) > 100000
      || geometry.widthMm < 1 || geometry.heightMm < 1 || geometry.widthMm > 100000 || geometry.heightMm > 100000) {
      throw new Error('图片长度和宽度需为 1～100000 mm，位置必须为有效毫米坐标。');
    }
    const object = active.document.objects.find(item => item.id === objectId);
    if (!object) throw new Error('图片对象不存在。');
    object.xMm = geometry.xMm; object.yMm = geometry.yMm;
    object.widthMm = geometry.widthMm; object.heightMm = geometry.heightMm;
  }

  /** 整页方向与对象角度分开保存，不重算或累计改变任何对象坐标。 */
  setOrientation(albumId: string, pageId: string, orientation: Orientation): void {
    assertOrientation(orientation);
    this.current(albumId, pageId).document.orientation = orientation;
  }

  /** 删除本页独立副本，JSON 提交失败则恢复文件，不触碰 assets。 */
  async deleteImage(albumId: string, pageId: string, objectId: string): Promise<void> {
    const active = this.current(albumId, pageId);
    if (this.dirty) throw new Error('请先保存或放弃当前画布修改。');
    const object = active.document.objects.find(item => item.id === objectId);
    if (!object) throw new Error('图片对象不存在。');
    const { path } = await this.pageDirectory(albumId, pageId);
    const file = join(path, object.fileName);
    const isolated = join(path, `.delete-${randomUUID()}.tmp`);
    let moved = false;
    try { await this.imagePath(albumId, pageId, objectId); await rename(file, isolated); moved = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    try { await this.commit({ ...active.document, objects: active.document.objects.filter(item => item.id !== objectId) }); }
    catch (error) { if (moved) await rename(isolated, file); throw error; }
    if (moved) await unlink(isolated);
    active.warnings = active.warnings.filter(warning => !warning.startsWith(`${object.fileName} `));
  }

  /** 资源协议按当前会话、页面 ID 和对象 ID 定位文件，拒绝任意路径和目录链接。 */
  async imagePath(albumId: string, pageId: string, objectId: string, loaded?: CanvasDocument): Promise<string> {
    const document = loaded ?? this.current(albumId, pageId).document;
    const object = document.objects.find(item => item.id === objectId);
    if (!object) throw new Error('图片对象不存在。');
    const { path } = await this.pageDirectory(albumId, pageId);
    const file = join(path, object.fileName);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('页面图片不能是目录或链接。');
    return file;
  }
}
