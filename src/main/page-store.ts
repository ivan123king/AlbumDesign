/** 文件用途：管理正式页面、单页编辑草稿、独立图片副本及可回滚的普通文件操作。 */
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { AlbumPageReference } from '../shared/album';
import type { CanvasDocument, CanvasSnapshot, ImageGeometry, ImageObject, TextDraft, TextObject } from '../shared/canvas';
import { fitImage, normalizeAngle, objectNameError, rotateVector, textBaseSize } from '../shared/canvas';
import type { CropBounds } from '../shared/crop';
import { getTextFonts, textFontFamilies } from './text-fonts';
import type { Orientation } from '../shared/framework';
import { AlbumStore, publishExclusive } from './album-store';
import { replaceJson } from './json-storage';

export type InspectImage = (path: string, format: 'jpeg' | 'png') => Promise<{ width: number; height: number }>;

/** 流式核对本次生成文件，崩溃恢复时不删除外部程序写入的同名图片。 */
async function cropFileHash(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** 文件身份只用于裁剪旧图清理，发现外部更新则保留文件并报告。 */
async function cropFileStamp(path: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('裁剪清理目标不是普通图片。');
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
}

/** 方向仅有两种；来自 IPC 的值必须运行时检查。 */
export function assertOrientation(value: unknown): asserts value is Orientation {
  if (value !== 'portrait' && value !== 'landscape') throw new Error('画布方向无效。');
}

/** 显示名称与文件名无关，可以使用中文和标点，但不能留空或无限增长。 */
function assertPageName(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > 120 || /[\u0000-\u001f]/u.test(value)) throw new Error('画布名称需为 1～120 个可见字符。');
}

/** 文字排版参数在 IPC 和读盘时共用校验，禁止无效尺寸、样式和过量内容。 */
function validateText(draft: TextDraft): void {
  const bounds = draft?.contentBounds;
  if (bounds !== undefined && (!bounds || ![bounds.xMm, bounds.yMm, bounds.widthMm, bounds.heightMm].every(Number.isFinite)
    || Math.abs(bounds.xMm) > 100000 || Math.abs(bounds.yMm) > 100000
    || bounds.widthMm < 1 || bounds.heightMm < 1 || bounds.widthMm > 100000 || bounds.heightMm > 100000)) {
    throw new Error('文字内容边界无效，请重新编辑文字。');
  }
  if (!draft || typeof draft.text !== 'string' || !draft.text.trim() || draft.text.length > 100000
    || !['horizontal', 'vertical'].includes(draft.writingMode) || !textFontFamilies.includes(draft.fontFamily)
    || typeof draft.color !== 'string' || !/^#[0-9a-f]{6}$/iu.test(draft.color)
    || !Number.isFinite(draft.fontSizePt) || draft.fontSizePt < 0.1 || draft.fontSizePt > 10000
    || !Number.isFinite(draft.letterSpacingPt) || draft.letterSpacingPt < -1000 || draft.letterSpacingPt > 10000
    || !Number.isFinite(draft.lineSpacing) || draft.lineSpacing < 0.5 || draft.lineSpacing > 5
    || !Number.isSafeInteger(draft.columns) || draft.columns < 1 || draft.columns > 8 || (draft.writingMode === 'vertical' && draft.columns !== 1)
    || !Number.isFinite(draft.columnGapMm) || draft.columnGapMm < 0 || draft.columnGapMm > 100000
    || ![draft.widthMm, draft.heightMm].every(value => Number.isFinite(value) && value >= 1 && value <= 100000)) {
    throw new Error('文字内容、字体、尺寸或排版参数无效。');
  }
}

/** 兼容版本 1 图片页面；版本 2 支持真实文字和任意对象角度，不默默降级未知数据。 */
export function parseCanvas(value: unknown): CanvasDocument {
  if (!value || typeof value !== 'object') throw new Error('画布文件格式错误。');
  const data = value as CanvasDocument;
  assertOrientation(data.orientation);
  if (![1, 2].includes(data.formatVersion) || data.widthMm !== 210 || data.heightMm !== 297
    || !Number.isSafeInteger(data.nextImageNumber) || data.nextImageNumber < 1 || !Array.isArray(data.objects)) throw new Error('画布格式、A4 尺寸或图片计数无效。');
  const ids = new Set<string>();
  const files = new Set<string>();
  const layers = new Set<number>();
  for (const item of data.objects) {
    if (!item || !['image', 'text'].includes(item.kind) || typeof item.id !== 'string' || !item.id || ids.has(item.id)
      || ![item.xMm, item.yMm, item.widthMm, item.heightMm].every(Number.isFinite)
      || Math.abs(item.xMm) > 100000 || Math.abs(item.yMm) > 100000 || item.widthMm <= 0 || item.heightMm <= 0
      || item.widthMm > 100000 || item.heightMm > 100000 || !Number.isFinite(item.rotation) || item.rotation < 0 || item.rotation >= 360
      || !Number.isSafeInteger(item.zIndex) || item.zIndex < 0 || layers.has(item.zIndex)) throw new Error('画布对象包含无效坐标、角度或叠层。');
    if (item.displayName !== undefined) {
      const error = objectNameError(item.displayName);
      if (error) throw new Error(error);
    }
    if (data.formatVersion === 1 && (item.kind !== 'image' || ![0, 90, 180, 270].includes(item.rotation))) throw new Error('旧版本页面不能保存文字或自由角度。');
    if (item.kind === 'image') {
      if (typeof item.fileName !== 'string' || !/^\d{3,}\.(?:jpg|jpeg|png)$/iu.test(item.fileName)
        || files.has(item.fileName.toLowerCase()) || Number(item.fileName.split('.')[0]) < 1
        || Number(item.fileName.split('.')[0]) >= data.nextImageNumber || typeof item.sourceName !== 'string'
        || item.sourceName.length > 255) throw new Error('图片文件编号或引用无效。');
      files.add(item.fileName.toLowerCase());
    } else {
      validateText(item);
      if (![item.layoutWidthMm, item.layoutHeightMm].every(size => Number.isFinite(size) && size >= 1 && size <= 100000)
        || Math.abs(item.widthMm / textBaseSize(item).widthMm - item.heightMm / textBaseSize(item).heightMm) > 1e-7 * Math.max(1, item.widthMm / textBaseSize(item).widthMm)) {
        throw new Error('文字框只允许等比例缩放。');
      }
    }
    ids.add(item.id); layers.add(item.zIndex);
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

/** 只缓存当前页；排版与叠层草稿需手动保存，结构性文件操作在无草稿时提交。 */
export class PageStore {
  private cropStages = new Map<string, { directory: string; file: string; fileName: string; previousName: string }>();
  private active: { albumId: string; pageId: string; document: CanvasDocument; saved: CanvasDocument; text: string; warnings: string[] } | null = null;

  constructor(private readonly albums: AlbumStore, private readonly inspect: InspectImage) {}

  /** 返回独立快照，不把图片二进制或磁盘绝对路径发送到界面。 */
  snapshot(): CanvasSnapshot | null {
    if (!this.active) return null;
    return { pageId: this.active.pageId, document: structuredClone(this.active.document), dirty: this.dirty,
      warnings: [...this.active.warnings] };
  }

  get dirty(): boolean { return !!this.active && JSON.stringify(this.active.document) !== JSON.stringify(this.active.saved); }

  /** 放弃名称、文字、几何、叠层、方向及暂存裁剪；已提交的图片导入或页面操作保留。 */
  async discard(): Promise<void> {
    if (this.active) this.active.document = structuredClone(this.active.saved);
    const stages = [...this.cropStages.values()];
    this.cropStages.clear();
    for (const stage of stages) {
      try { await this.cleanCropStage(stage.directory, this.active!.saved); }
      catch (error) { this.active?.warnings.push(`已放弃修改，裁剪临时文件待下次打开清理：${String(error)}`); }
    }
  }

  /** 仅清理带有效事务记录的本软件裁剪目录；JSON 已提交则删旧图，否则删未提交的新图。 */
  private async cleanCropStage(directory: string, document: CanvasDocument): Promise<void> {
    await plainDirectory(directory);
    const marker = join(directory, 'transaction.json');
    const info = await lstat(marker);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 2048) throw new Error('裁剪事务记录无效。');
    const record = JSON.parse(await readFile(marker, 'utf8')) as { fileName: string; previousName: string; resultHash: string; previousStamp: string };
    if (![record.fileName, record.previousName].every(name => typeof name === 'string' && /^\d{3,}\.(jpg|jpeg|png)$/iu.test(name))
      || typeof record.resultHash !== 'string' || !/^[a-f0-9]{64}$/u.test(record.resultHash) || typeof record.previousStamp !== 'string') throw new Error('裁剪事务记录无效。');
    if ((await readdir(directory)).some(name => !['result.png', 'transaction.json'].includes(name))) throw new Error('裁剪临时目录含未知文件，未清理。');
    const used = new Set(document.objects.filter(item => item.kind === 'image').map(item => item.fileName));
    const page = join(directory, '..'); await plainDirectory(page);
    for (const name of [record.fileName, record.previousName]) {
      if (used.has(name)) continue;
      const file = join(page, name);
      try {
        const stamp = await cropFileStamp(file);
        if (name === record.fileName ? await cropFileHash(file) !== record.resultHash : stamp !== record.previousStamp) throw new Error(`图片 ${name} 已被外部修改，未自动删除。`);
        await unlink(file);
      }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    // 不递归删除未知内容；只移除本事务约定的两个文件，异常条目保留并报告。
    await unlink(join(directory, 'result.png')).catch(error => { if (error.code !== 'ENOENT') throw error; });
    const { rmdir } = await import('node:fs/promises');
    await unlink(marker); await rmdir(directory);
  }

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
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isDirectory() && /^\.crop-[a-zA-Z0-9]+$/u.test(entry.name)) {
        try { await this.cleanCropStage(join(path, entry.name), document); }
        catch (error) { warnings.push(`裁剪临时文件清理失败：${String(error)}`); }
      }
    }
    const fonts = document.objects.some(object => object.kind === 'text') ? await getTextFonts() : [];
    for (const object of document.objects) {
      if (object.kind === 'text') {
        if (!fonts.some(font => font.family === object.fontFamily && font.available)) warnings.push(`文字字体缺失：${object.fontFamily}，请安装字体或重新编辑选择字体。`);
        continue;
      }
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
      const document: CanvasDocument = { formatVersion: 2, widthMm: 210, heightMm: 297, orientation, nextImageNumber: 1, objects: [] };
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
    const published: string[] = [];
    let text: string;
    try {
      for (const stage of this.cropStages.values()) {
        const destination = join(path, stage.fileName);
        await publishExclusive(stage.file, destination); published.push(destination);
      }
      text = await replaceJson(join(path, 'canvas.json'), active.document, active.text);
    } catch (error) {
      for (const file of published) await unlink(file).catch(() => undefined);
      throw error;
    }
    active.text = text;
    active.saved = structuredClone(active.document);
    for (const stage of this.cropStages.values()) {
      try { await this.cleanCropStage(stage.directory, active.saved); }
      catch (error) { active.warnings.push(`图片已保存，旧图片清理失败，下次打开重试：${String(error)}`); }
    }
    this.cropStages.clear();
  }

  /** 裁剪先进入草稿；预留编号独立持久化，保存后才删旧图，放弃可恢复原图片。 */
  async stageCrop(albumId: string, pageId: string, objectId: string, png: Buffer, bounds: CropBounds, width: number, height: number): Promise<void> {
    const active = this.current(albumId, pageId);
    const object = active.document.objects.find(item => item.id === objectId);
    if (!object || object.kind !== 'image') throw new Error('裁剪图片不存在。');
    const { path } = await this.pageDirectory(albumId, pageId);
    const reserved = structuredClone(active.saved);
    const number = Math.max(reserved.nextImageNumber, active.document.nextImageNumber);
    reserved.nextImageNumber = number + 1;
    active.text = await replaceJson(join(path, 'canvas.json'), reserved, active.text);
    active.saved = reserved; active.document.nextImageNumber = number + 1;
    const fileName = `${String(number).padStart(3, '0')}.png`;
    const previousName = active.saved.objects.find(item => item.id === objectId && item.kind === 'image')!;
    const directory = await mkdtemp(join(path, '.crop-'));
    const stage = { directory, file: join(directory, 'result.png'), fileName,
      previousName: (previousName as ImageObject).fileName };
    try {
      const previousStamp = await cropFileStamp(join(path, stage.previousName));
      await writeFile(stage.file, png, { flag: 'wx' });
      const resultHash = await cropFileHash(stage.file);
      await writeFile(join(directory, 'transaction.json'), JSON.stringify({ fileName, previousName: stage.previousName, resultHash, previousStamp }), { flag: 'wx' });
      const former = this.cropStages.get(objectId);
      if (former) await this.cleanCropStage(former.directory, active.saved);
      const shift = rotateVector(((bounds.x + bounds.width / 2) / width - .5) * object.widthMm,
        ((bounds.y + bounds.height / 2) / height - .5) * object.heightMm, object.rotation);
      const widthMm = object.widthMm * bounds.width / width, heightMm = object.heightMm * bounds.height / height;
      object.xMm += object.widthMm / 2 + shift.x - widthMm / 2;
      object.yMm += object.heightMm / 2 + shift.y - heightMm / 2;
      object.widthMm = widthMm; object.heightMm = heightMm; object.fileName = fileName;
      this.cropStages.set(objectId, stage);
    } catch (error) {
      await unlink(stage.file).catch(() => undefined);
      await unlink(join(directory, 'transaction.json')).catch(() => undefined);
      const { rmdir } = await import('node:fs/promises'); await rmdir(directory).catch(() => undefined);
      throw error;
    }
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
    if (object.kind === 'text' && Math.abs(geometry.widthMm / object.widthMm - geometry.heightMm / object.heightMm) > 1e-7 * Math.max(1, geometry.widthMm / object.widthMm)) {
      throw new Error('文字只支持四角等比例缩放，不能单独拉伸长宽。');
    }
    object.xMm = geometry.xMm; object.yMm = geometry.yMm;
    object.widthMm = geometry.widthMm; object.heightMm = geometry.heightMm;
  }

  /** 名称只更新当前页对象草稿；null 删除自定义字段，无效名称或失效目标不产生部分修改。 */
  renameObject(albumId: string, pageId: string, objectId: string, name: string | null): void {
    const active = this.current(albumId, pageId);
    if (name !== null) {
      const error = objectNameError(name);
      if (error) throw new Error(error);
    }
    const object = active.document.objects.find(item => item.id === objectId);
    if (!object) throw new Error('对象不存在。');
    if (name === null) delete object.displayName;
    else object.displayName = name.trim();
  }

  /** targetIndex 为从顶层起的零基位置；仅调整当前页叠层草稿，无效对象或位置拒绝且不部分修改。 */
  reorderObject(albumId: string, pageId: string, objectId: string, targetIndex: number): void {
    const active = this.current(albumId, pageId);
    const ordered = [...active.document.objects].sort((a, b) => b.zIndex - a.zIndex);
    const sourceIndex = ordered.findIndex(item => item.id === objectId);
    if (sourceIndex < 0) throw new Error('图层对象不存在。');
    if (!Number.isSafeInteger(targetIndex) || targetIndex < 0 || targetIndex >= ordered.length) throw new Error('图层目标位置无效。');
    if (sourceIndex === targetIndex) return;
    const [object] = ordered.splice(sourceIndex, 1);
    ordered.splice(targetIndex, 0, object!);
    // zIndex 是唯一叠层依据；连续编号仅用于叠放，不改对象 ID、图片编号或数组存储顺序。
    ordered.forEach((item, index) => { item.zIndex = ordered.length - index - 1; });
  }

  /** 自由旋转只修改自身角度，不改变中心、长宽或叠层；保存时才升级旧页面格式。 */
  rotate(albumId: string, pageId: string, objectId: string, angle: number): void {
    const active = this.current(albumId, pageId);
    if (!Number.isFinite(angle) || Math.abs(angle) > 1e7) throw new Error('旋转角度无效。');
    const object = active.document.objects.find(item => item.id === objectId);
    if (!object) throw new Error('对象不存在。');
    object.rotation = normalizeAngle(angle);
    if (object.rotation % 90 !== 0) active.document.formatVersion = 2;
  }

  /** 创建或重新编辑真实文字；编辑时以实际字号和区域重新排版，不消耗图片编号。 */
  async putText(albumId: string, pageId: string, objectId: string | null, draft: TextDraft,
    position?: { xMm: number; yMm: number }): Promise<string> {
    const active = this.current(albumId, pageId);
    validateText(draft);
    if (!(await getTextFonts()).some(font => font.family === draft.fontFamily && font.available)) throw new Error('所选字体未安装，请更换字体后重试。');
    const previous = objectId ? active.document.objects.find(item => item.id === objectId) : undefined;
    if (objectId && previous?.kind !== 'text') throw new Error('文字对象不存在。');
    if (position && (![position.xMm, position.yMm].every(Number.isFinite) || Math.abs(position.xMm) > 100000 || Math.abs(position.yMm) > 100000)) throw new Error('文字位置无效。');
    const cx = previous ? previous.xMm + previous.widthMm / 2 : position?.xMm ?? 105;
    const cy = previous ? previous.yMm + previous.heightMm / 2 : position?.yMm ?? 148.5;
    const widthMm = draft.contentBounds?.widthMm ?? draft.widthMm;
    const heightMm = draft.contentBounds?.heightMm ?? draft.heightMm;
    const object: TextObject = { ...draft, kind: 'text', id: previous?.id ?? randomUUID(), widthMm, heightMm,
      xMm: cx - widthMm / 2, yMm: cy - heightMm / 2,
      rotation: previous?.rotation ?? (active.document.orientation === 'landscape' ? 90 : 0),
      zIndex: previous?.zIndex ?? Math.max(-1, ...active.document.objects.map(item => item.zIndex)) + 1,
      layoutWidthMm: draft.widthMm, layoutHeightMm: draft.heightMm };
    // 正文编辑沿用独立名称；恢复默认后保持字段缺省，摘要继续随正文变化。
    delete object.displayName;
    if (previous?.displayName !== undefined) object.displayName = previous.displayName;
    const next: CanvasDocument = { ...active.document, formatVersion: 2,
      objects: previous ? active.document.objects.map(item => item.id === objectId ? object : item) : [...active.document.objects, object] };
    parseCanvas(next);
    active.document = next;
    return object.id;
  }

  /** 整页方向与对象角度分开保存，不重算或累计改变任何对象坐标。 */
  setOrientation(albumId: string, pageId: string, orientation: Orientation): void {
    assertOrientation(orientation);
    this.current(albumId, pageId).document.orientation = orientation;
  }

  /** 删除文字仅提交对象记录；图片同时删除本页副本，失败恢复，不触碰 assets。 */
  async deleteObject(albumId: string, pageId: string, objectId: string): Promise<void> {
    const active = this.current(albumId, pageId);
    if (this.dirty) throw new Error('请先保存或放弃当前画布修改。');
    const object = active.document.objects.find(item => item.id === objectId);
    if (!object) throw new Error('图片对象不存在。');
    if (object.kind === 'text') {
      await this.commit({ ...active.document, objects: active.document.objects.filter(item => item.id !== objectId) });
      return;
    }
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

  /** 保留既有图片验收入口，实际删除由共用对象流程处理。 */
  async deleteImage(albumId: string, pageId: string, objectId: string): Promise<void> {
    await this.deleteObject(albumId, pageId, objectId);
  }

  /** 资源协议按当前会话、页面 ID 和对象 ID 定位文件，拒绝任意路径和目录链接。 */
  async imagePath(albumId: string, pageId: string, objectId: string, loaded?: CanvasDocument): Promise<string> {
    const document = loaded ?? this.current(albumId, pageId).document;
    const object = document.objects.find(item => item.id === objectId);
    if (!object || object.kind !== 'image') throw new Error('图片对象不存在。');
    const { path } = await this.pageDirectory(albumId, pageId);
    const staged = !loaded && this.cropStages.get(objectId);
    const file = staged ? staged.file : join(path, object.fileName);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('页面图片不能是目录或链接。');
    return file;
  }
}
