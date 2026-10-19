/** 文件用途：逐页打印真实画册、后台合并并安全发布 PDF，统一控制资源、进度和取消。 */
import { Worker } from 'node:worker_threads';
import { lstat, mkdtemp, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import type { AlbumStore } from './album-store';
import { publishExclusive } from './album-store';
import type { PageStore } from './page-store';
import type { PdfPrintPage, PdfProgress } from '../shared/pdf';

/** 超时必须可终止后台窗口；定时器随实际操作结束释放，不遗留后台等待。 */
async function bounded<T>(operation: Promise<T>, message: string, signal: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), 60000);
    cancel = () => reject(new Error('已取消 PDF 导出。'));
    if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true });
  })]); }
  finally { clearTimeout(timer); if (cancel) signal.removeEventListener('abort', cancel); }
}

/** 读取目标快照；拒绝链接或目录。导出期间外部改写目标时拒绝覆盖。 */
async function targetStamp(path: string): Promise<string | null> {
  try {
    const stat = await lstat(path, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('PDF 目标必须是普通文件，不能覆盖目录或链接。');
    return `${stat.dev}/${stat.ino}/${stat.size}/${stat.mtimeNs}/${stat.ctimeNs}`;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

/** 一次任务独占一个后台窗口和合并线程，页面数据不改变编辑器当前页或草稿。 */
export class PdfExport {
  private window: BrowserWindow | null = null;
  private worker: Worker | null = null;
  private page: PdfPrintPage | null = null;
  private canceled = false;
  private publishing = false;
  private total = 0;
  private readonly cancellation = new AbortController();

  constructor(private readonly store: AlbumStore, private readonly reader: PageStore,
    private readonly createWindow: () => BrowserWindow, private readonly loadWindow: (window: BrowserWindow) => Promise<void>,
    private readonly onProgress: (progress: PdfProgress) => void) {}

  /** 只允许本任务的打印窗口顶层查询当前页，主窗口及其他 frame 均无权读取。 */
  printPage(event: IpcMainInvokeEvent): PdfPrintPage {
    if (!this.window || event.sender !== this.window.webContents || event.senderFrame !== this.window.webContents.mainFrame || !this.page) {
      throw new Error('打印任务已失效或调用来源无效。');
    }
    return structuredClone(this.page);
  }

  /** 页面资源复用已校验的普通文件读取；只放行本次正在打印的一页。 */
  imagePath(albumId: string, pageId: string, objectId: string): Promise<string> | null {
    if (!this.page || this.page.albumId !== albumId || this.page.pageId !== pageId) return null;
    return this.reader.imagePath(albumId, pageId, objectId, this.page.document);
  }

  /** 发布前允许立即取消；销毁解码/打印窗口与合并线程，提交开始后等待最终文件结果。 */
  cancel(): void {
    if (this.publishing || this.canceled) return;
    this.canceled = true;
    this.cancellation.abort();
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    void this.worker?.terminate();
  }

  /** 异步文件操作结束后再次检查，防止取消后继续启动下一步打印或发布。 */
  private checkCanceled(): void { if (this.canceled) throw new Error('已取消 PDF 导出。'); }

  /** completed 为当前阶段完成页数，取消按钮只在最终发布前可用。 */
  private progress(phase: PdfProgress['phase'], completed: number): void {
    this.onProgress({ phase, completed, total: this.total, canceling: this.canceled });
  }

  /** 输出位置只来自主进程原生对话框；失败不修改目标，取消返回 false。 */
  async run(albumId: string, destination: string, title: string): Promise<boolean> {
    let temporary: string | null = null;
    try {
      const { root, manifest } = await this.store.project(albumId);
      const local = relative(root, resolve(destination)).split(sep);
      if (['assets', 'pages', 'cache'].includes(local[0]?.toLowerCase() ?? '')) throw new Error('请将 PDF 保存在画册资源目录以外的位置。');
      const originalTarget = await targetStamp(destination);
      this.total = manifest.pages.length;
      if (!this.total) throw new Error('画册没有画布，无法导出 PDF。');
      temporary = await mkdtemp(join(dirname(destination), '.album-pdf-'));
      const files: string[] = [];
      this.progress('preparing', 0);
      this.window = this.createWindow();
      for (let index = 0; index < manifest.pages.length; index++) {
        const reference = manifest.pages[index]!;
        this.checkCanceled(); this.progress('printing', index);
        try {
          await this.reader.load(albumId, reference.id);
          const snapshot = this.reader.snapshot()!;
          if (snapshot.warnings.length) throw new Error(snapshot.warnings.join('\n'));
          this.page = { albumId, pageId: reference.id, document: snapshot.document };
          this.checkCanceled();
          await bounded(this.loadWindow(this.window), '打印窗口加载超时。', this.cancellation.signal);
          // 字体和原图必须全部就绪；坏图不能作为占位图进入正式 PDF。
          await bounded(this.window.webContents.executeJavaScript(`(async () => {
            while (!document.querySelector('[data-print-ready]')) {
              const error = document.querySelector('[data-print-error]');
              if (error) throw new Error(error.textContent);
              await new Promise(resolve => setTimeout(resolve, 25));
            }
            await document.fonts.ready;
            await Promise.all([...document.images].map(async image => {
              try { await image.decode(); } catch { throw new Error('图片解码失败：' + image.alt); }
              if (!image.naturalWidth || !image.naturalHeight) throw new Error('图片内容为空：' + image.alt);
            }));
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          })()`), '图片或字体加载超时。', this.cancellation.signal);
          this.checkCanceled();
          const pdf = await bounded(this.window.webContents.printToPDF({ pageSize: 'A4', landscape: false,
            printBackground: true, displayHeaderFooter: false, preferCSSPageSize: true, scale: 1,
            margins: { top: 0, bottom: 0, left: 0, right: 0 } }), '打印页面超时。', this.cancellation.signal);
          this.checkCanceled();
          const file = join(temporary, `${index}.pdf`);
          await writeFile(file, pdf, { flag: 'wx' }); files.push(file);
          this.page = null; this.progress('printing', index + 1);
        } catch (error) { throw new Error(`第 ${index + 1} 页「${reference.name}」：${error instanceof Error ? error.message : String(error)}`); }
      }
      this.window.destroy(); this.window = null;
      const output = join(temporary, 'complete.pdf');
      this.checkCanceled(); this.progress('merging', 0);
      await this.merge(files, output, title);
      this.checkCanceled();
      if (await targetStamp(destination) !== originalTarget) throw new Error('导出期间目标文件发生变化，未覆盖，请重新选择保存位置。');
      this.checkCanceled(); this.publishing = true; this.progress('publishing', this.total);
      // 同卷临时文件完成后才替换；新文件排他发布，覆盖失败时原文件仍保留。
      if (originalTarget !== null) await rename(output, destination);
      else { await publishExclusive(output, destination); await unlink(output); }
      return true;
    } catch (error) { if (this.canceled) return false; throw error; }
    finally {
      this.page = null;
      if (this.window && !this.window.isDestroyed()) this.window.destroy(); this.window = null;
      if (this.worker) await this.worker.terminate(); this.worker = null;
      // 仅清理由本任务 mkdtemp 创建、且仍位于目标同级的缓存目录，不触及画册和已有 PDF。
      if (temporary && dirname(temporary) === resolve(dirname(destination))) await rm(temporary, { recursive: true, force: true });
    }
  }

  /** 合并计算在独立线程执行，可终止；异常退出也必须结束等待并回收临时文件。 */
  private async merge(files: string[], output: string, title: string): Promise<void> {
    await new Promise<void>((accept, reject) => {
      let done = false;
      const worker = new Worker(join(__dirname, 'pdf-worker.cjs'), { workerData: { files, output, title } });
      this.worker = worker;
      worker.on('message', (message: { completed?: number; done?: boolean; error?: string }) => {
        if (message.error) reject(new Error(message.error));
        else if (message.done) { done = true; accept(); }
        else if (message.completed !== undefined) this.progress('merging', message.completed);
      });
      worker.once('error', reject);
      worker.once('exit', code => { if (!done) reject(new Error(this.canceled ? '已取消导出。' : `PDF 合并线程异常退出（${code}）。`)); });
    });
  }
}
