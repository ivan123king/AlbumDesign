/** 文件用途：管理一次裁剪的只读源图快照、后台原像素处理及受限替换，界面不传文件路径或成品字节。 */
import { app } from 'electron';
import { copyFile, lstat, mkdtemp, rm } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { ImageValidationTask, leaseCropImage } from './image-validator';
import type { AlbumStore } from './album-store';
import type { PageStore } from './page-store';
import type { CropSettings, CropSource, CropTarget } from '../shared/crop';

/** 同一时刻只允许一个裁剪弹框；源文件元数据变化后拒绝覆盖，要求重新打开。 */
export class CropImages {
  private session: { target: CropTarget; directory: string; source: string; original: string; fingerprint: string;
    lease: ReturnType<typeof leaseCropImage>; width: number; height: number } | null = null;
  get active(): boolean { return this.session !== null; }

  /** 只接受业务目标，主进程自行解析安全路径；复制后校验源文件未在准备期间改变。 */
  async begin(target: CropTarget, store: AlbumStore, pages: PageStore): Promise<CropSource> {
    if (this.session) throw new Error('请先关闭当前裁剪弹框。');
    if (!target || !['asset', 'page'].includes(target.kind) || typeof target.albumId !== 'string'
      || (target.kind === 'asset' ? typeof target.path !== 'string' : typeof target.pageId !== 'string' || typeof target.objectId !== 'string')) throw new Error('裁剪目标无效。');
    const original = target.kind === 'asset' ? await store.assetFile(target.albumId, target.path)
      : await pages.imagePath(target.albumId, target.pageId, target.objectId);
    const before = await this.fingerprint(original);
    const directory = await mkdtemp(join(app.getPath('temp'), 'album-crop-'));
    const source = join(directory, 'source' + extname(original));
    const task = new ImageValidationTask();
    try {
      await copyFile(original, source);
      if (before !== await this.fingerprint(original)) throw new Error('图片已被外部修改，请重新打开裁剪。');
      const format = extname(source).toLowerCase() === '.png' ? 'png' : 'jpeg';
      const size = await task.inspect(source, format);
      if (size.width * size.height > 80000000 || Math.max(size.width, size.height) > 32767) throw new Error('图片过大，裁剪支持最长边 32767 像素且总像素不超过 8000 万。');
      const lease = leaseCropImage(source, format);
      this.session = { target: structuredClone(target), directory, source, original, fingerprint: before, lease, ...size };
      return { token: lease.token, url: lease.url, ...size };
    } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
    finally { task.dispose(); }
  }

  /** 检查只读快照对应的原文件；主进程业务锁覆盖处理与替换全过程。 */
  async apply(token: string, settings: CropSettings, store: AlbumStore, pages: PageStore): Promise<string | null> {
    const session = this.session;
    if (!session || session.lease.token !== token) throw new Error('裁剪弹框已失效，请重新打开。');
    const task = new ImageValidationTask();
    try {
      const result = await task.crop(session.source, extname(session.source).toLowerCase() === '.png' ? 'png' : 'jpeg', settings);
      const target = session.target;
      const original = target.kind === 'asset' ? await store.assetFile(target.albumId, target.path)
        : await pages.imagePath(target.albumId, target.pageId, target.objectId);
      if (this.session !== session || original !== session.original || await this.fingerprint(original) !== session.fingerprint) throw new Error('图片或画册已变化，请重新打开裁剪。');
      if (target.kind === 'asset') return await store.replaceCroppedAsset(target.albumId, target.path, result.png);
      await pages.stageCrop(target.albumId, target.pageId, target.objectId, result.png, result.bounds, result.width, result.height);
      return null;
    } finally { task.dispose(); }
  }

  /** 关闭及重载撤销令牌并释放源图副本，路径仅来自本类创建的系统临时目录。 */
  async release(token?: string): Promise<void> {
    const session = this.session;
    if (!session || (token !== undefined && token !== session.lease.token)) return;
    this.session = null; session.lease.release();
    await rm(session.directory, { recursive: true, force: true });
  }

  /** 普通文件元数据指纹用于拒绝编辑期间的外部替换，不遍历或哈希整张大图。 */
  private async fingerprint(path: string): Promise<string> {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('裁剪源不是普通图片文件。');
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
  }
}
