/** 文件用途：提供当前画册的素材浏览租约、原图读取和串行后台缩略图缓存，不占用业务写入队列。 */
import { net, protocol } from 'electron';
import { createHash } from 'node:crypto';
import { lstat, readFile, unlink, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AlbumStore, describeFileError } from './album-store';
import { ImageValidationTask } from './image-validator';
import type { AlbumResult } from '../shared/album';

interface ImageLease {
  id: string;
  albumId: string;
  assetPath: string;
  kind: 'preview' | 'thumbnail';
  store: AlbumStore;
  file?: string;
  retry: boolean;
  complete: (result: AlbumResult<string>) => void;
}

/** 每个可见图片持有一个租约；取消立即撤销地址，队列最多同时解码一张原图。 */
export class AssetImages {
  private leases = new Map<string, ImageLease>();
  private queue: ImageLease[] = [];
  private running = false;
  private task: ImageValidationTask | null = null;
  private decodedCount = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly currentStore: () => AlbumStore) {}

  /** 地址只包含随机租约，不接受磁盘路径；每次读取重新核验当前会话及源文件。 */
  install(): void {
    protocol.handle('album-asset', async request => {
      try {
        const url = new URL(request.url);
        const id = url.pathname.slice(1);
        const lease = this.leases.get(id);
        if (request.method !== 'GET' || url.hostname !== 'image' || url.search || !lease?.file) return new Response(null, { status: 404 });
        await this.check(lease);
        if (lease.kind === 'thumbnail') {
          await lease.store.assetThumbnailDirectory(lease.albumId);
          const stat = await lstat(lease.file);
          if (!stat.isFile() || stat.isSymbolicLink()) return new Response(null, { status: 404 });
        }
        const response = await net.fetch(pathToFileURL(lease.file).href);
        if (!this.active(lease)) return new Response(null, { status: 404 });
        return new Response(response.body, { status: response.status, headers: {
          'Content-Type': extname(lease.file).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg',
          'Cache-Control': 'no-store'
        } });
      } catch { return new Response(null, { status: 404 }); }
    });
  }

  /** 输入只允许当前会话、素材相对路径、浏览类型与唯一 UUID；取消返回 canceled，不弹系统错误框。 */
  request(albumId: string, assetPath: string, kind: 'preview' | 'thumbnail', id: string, retry = false): Promise<AlbumResult<string>> {
    if (typeof albumId !== 'string' || typeof assetPath !== 'string' || !['preview', 'thumbnail'].includes(kind)
      || typeof id !== 'string' || !/^[a-f0-9-]{36}$/u.test(id) || typeof retry !== 'boolean'
      || this.leases.has(id) || this.leases.size >= 200) return Promise.resolve({ status: 'error', message: '素材预览请求无效或过多。' });
    return new Promise(resolve => {
      const lease: ImageLease = { id, albumId, assetPath, kind, store: this.currentStore(), retry, complete: resolve };
      this.leases.set(id, lease);
      if (kind === 'preview') void this.preparePreview(lease);
      else { this.queue.push(lease); void this.drain(); }
    });
  }

  /** 释放操作幂等；移除待处理项并终结等待中的 Promise，正在解码的一张完成后丢弃结果。 */
  release(id: string): void {
    const lease = this.leases.get(id);
    this.leases.delete(id);
    this.queue = this.queue.filter(item => item.id !== id);
    lease?.complete({ status: 'canceled' });
  }

  /** 换画册或关闭时撤销全部租约与后台窗口，旧请求不能向新会话发布结果。 */
  reset(): void {
    for (const id of this.leases.keys()) this.release(id);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.task?.dispose(); this.task = null; this.decodedCount = 0;
  }

  /** 仅接受仍存活且属于当前存储实例的租约。 */
  private active(lease: ImageLease): boolean {
    return this.leases.get(lease.id) === lease && this.currentStore() === lease.store;
  }

  /** 所有异步边界后都核验租约；素材文件检查沿用工程内路径及链接限制。 */
  private async check(lease: ImageLease): Promise<string> {
    if (!this.active(lease)) throw new Error('预览已关闭或画册已切换。');
    const file = await lease.store.assetFile(lease.albumId, lease.assetPath);
    if (!this.active(lease)) throw new Error('预览已关闭或画册已切换。');
    return file;
  }

  /** 纯生命周期检查不重复扫描磁盘；实际读源图与写缓存前仍分别验证对应路径。 */
  private assertActive(lease: ImageLease): void {
    if (!this.active(lease)) throw new Error('预览已关闭或画册已切换。');
  }

  /** 原图仅获取受限地址，实际解码由当前弹框的单张图片执行。 */
  private async preparePreview(lease: ImageLease): Promise<void> {
    try { lease.file = await this.check(lease); this.finish(lease); }
    catch (error) { this.fail(lease, error); }
  }

  /** 成功保留租约至界面释放；失败立即移除，避免反复打开造成累积。 */
  private finish(lease: ImageLease): void {
    if (this.active(lease)) lease.complete({ status: 'success', value: `album-asset://image/${lease.id}` });
  }

  /** 失败不改变画册业务状态，单张坏图不能打断后续队列。 */
  private fail(lease: ImageLease, error: unknown): void {
    if (this.active(lease)) {
      lease.complete({ status: 'error', message: describeFileError(error) });
      this.leases.delete(lease.id);
    }
  }

  /** 缓存文件只使用固定版本和元数据摘要命名；不读取原图内容来计算整文件哈希。 */
  private async prepareThumbnail(lease: ImageLease): Promise<void> {
    const source = await this.check(lease);
    const info = await lstat(source);
    const fingerprint = `${lease.assetPath}\n${info.size}\n${info.mtimeMs}\n${info.ctimeMs}`;
    const key = createHash('sha256').update(`asset-png-256-v1\n${fingerprint}`).digest('hex');
    const directory = await lease.store.assetThumbnailDirectory(lease.albumId);
    const cached = join(directory, `${key}.png`);
    let exists = false;
    try {
      const stat = await lstat(cached);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('缩略图缓存不能是链接或目录。');
      const bytes = stat.size < 512 * 1024 ? await readFile(cached) : Buffer.alloc(0);
      exists = bytes.length >= 33 && bytes.length < 512 * 1024
        && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      // 只删除已经检查过的固定缓存文件；用户主动重试时也重新生成损坏的小图。
      if (!exists || lease.retry) { await unlink(cached); exists = false; }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.assertActive(lease);
    if (!exists) {
      this.task ??= new ImageValidationTask();
      const png = await this.task.thumbnail(source, extname(source).toLowerCase() === '.png' ? 'png' : 'jpeg');
      this.assertActive(lease);
      const after = await lstat(source);
      if (info.size !== after.size || info.mtimeMs !== after.mtimeMs || info.ctimeMs !== after.ctimeMs) throw new Error('图片已被外部修改，请刷新后重试。');
      // 排他写入，拒绝覆盖外部插入的缓存文件或链接；中断留下的坏缓存下次校验后重建。
      await lease.store.assetThumbnailDirectory(lease.albumId);
      await writeFile(cached, png, { flag: 'wx' });
      // 浏览器可能保留已解码缓存；每 16 张重建后台窗口，限制长期滚动产生的原图驻留。
      this.decodedCount++;
      if (this.decodedCount >= 16) { this.task.dispose(); this.task = null; this.decodedCount = 0; }
    }
    this.assertActive(lease);
    lease.file = cached;
    this.finish(lease);
  }

  /** 单任务后台队列不广播 busy；空闲两秒销毁解码窗口，浏览目录时不长期占用后台进程。 */
  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    try {
      let lease: ImageLease | undefined;
      while ((lease = this.queue.shift())) {
        if (!this.active(lease)) continue;
        try { await this.prepareThumbnail(lease); }
        catch (error) { this.fail(lease, error); }
      }
    } finally {
      this.running = false;
      this.idleTimer = setTimeout(() => { this.task?.dispose(); this.task = null; this.decodedCount = 0; this.idleTimer = null; }, 2000);
    }
  }
}
