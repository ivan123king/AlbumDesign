/** 文件用途：串行执行画册操作，通过原生对话框授权外部路径并广播素材状态。 */
import { dialog, ipcMain, Menu } from 'electron';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { AlbumStore, describeFileError } from './album-store';
import { ImageValidationTask } from './image-validator';
import { installPageImageProtocol } from './image-validator';
import { PageStore } from './page-store';
import { AssetImages } from './asset-images';
import type { Orientation } from '../shared/framework';
import type { ImageGeometry, TextDraft } from '../shared/canvas';
import { getTextFonts } from './text-fonts';
import type { AppDataStore } from './app-data';
import type { AppDialogs } from './app-dialogs';
import type { AlbumResult, AlbumSnapshot, AlbumState, AssetEntry, ImportReport } from '../shared/album';
import { PdfExport } from './pdf-export';
import { pdfFileName } from '../shared/pdf';
import { CropImages } from './crop-images';
import type { CropSettings, CropTarget } from '../shared/crop';

/** 主菜单与 preload 共用控制器，避免并行导入和切换画册造成错写。 */
export class AlbumController {
  private store = new AlbumStore();
  private pages = this.makePages(this.store);
  private assetImages = new AssetImages(() => this.store);
  private cropImages = new CropImages();
  private state: AlbumState = { revision: 0, album: null, busy: false, progress: null, canvas: null };
  private initialized = false;
  private pdf: PdfExport | null = null;
  private pdfWindows: { create: () => BrowserWindow; load: (window: BrowserWindow) => Promise<void> } | null = null;

  constructor(private readonly getWindow: () => BrowserWindow,
    private readonly assertSender: (event: IpcMainInvokeEvent) => void,
    private readonly appData: AppDataStore,
    private readonly dialogs: AppDialogs) {}

  /** 每次广播增加版本号，界面能忽略初始化期间晚到的旧快照。 */
  private publish(change: Partial<AlbumState>): void {
    this.state = { ...this.state, ...change, revision: this.state.revision + 1 };
    const window = this.getWindow();
    if (!window.isDestroyed()) window.webContents.send('album:state', this.state);
    this.updateMenu();
  }

  /** 业务忙碌或自定义模态打开时禁用其他菜单入口，保存仍要求当前画布有草稿。 */
  updateMenu(): void {
    const locked = this.state.busy || this.dialogs.isOpen || this.cropImages.active;
    for (const id of ['create-album', 'open-album', 'about-app']) {
      const item = Menu.getApplicationMenu()?.getMenuItemById(id);
      if (item) item.enabled = !locked;
    }
    const save = Menu.getApplicationMenu()?.getMenuItemById('save-page');
    const exportItem = Menu.getApplicationMenu()?.getMenuItemById('export-pdf');
    if (exportItem) exportItem.enabled = !locked && !!this.state.album?.pages.length;
    if (save) save.enabled = !locked && !!this.state.canvas?.dirty;
    const reopen = Menu.getApplicationMenu()?.getMenuItemById('reopen-last-album');
    if (reopen) { reopen.checked = this.appData.reopenLastAlbum; reopen.enabled = !locked; }
  }

  /** 后台校验器按单次页面图片操作创建，完成后立即释放。 */
  private makePages(store: AlbumStore): PageStore {
    return new PageStore(store, async (path, format) => {
      const task = new ImageValidationTask();
      try { return await task.inspect(path, format); } finally { task.dispose(); }
    });
  }

  /** 手动保存的草稿在离页或文件结构操作前统一确认，取消保留当前界面和修改。 */
  private async guardDirty(): Promise<boolean> {
    if (!this.pages.dirty) return true;
    const subject = this.state.album?.pages.find(page => page.id === this.state.canvas?.pageId)?.name ?? '当前画布';
    const answer = await this.dialogs.confirmUnsaved(subject);
    if (answer === 'cancel') return false;
    if (answer === 'save') await this.pages.save(); else await this.pages.discard();
    return true;
  }

  /** 忙碌时直接拒绝；取消与失败分别返回，启动及软件设置错误用非阻塞提示反馈。 */
  private async run<T>(operation: () => Promise<T | undefined>, quietFailure?: string, allowCrop = false): Promise<AlbumResult<T>> {
    if (this.state.busy || this.dialogs.isOpen || (!allowCrop && this.cropImages.active)) return { status: 'error', message: '请先完成当前操作或关闭弹窗。' };
    this.publish({ busy: true, progress: null });
    try {
      const value = await operation();
      return value === undefined ? { status: 'canceled' } : { status: 'success', value };
    } catch (error) {
      const message = describeFileError(error);
      if (quietFailure) this.publish({ notice: [this.state.notice, `${quietFailure}：${message}`].filter(Boolean).join('\n') });
      else await dialog.showMessageBox(this.getWindow(), { type: 'error', title: '画册操作失败', message });
      return { status: 'error', message };
    } finally {
      let album = this.state.album;
      if (album) album = { ...album, pages: this.store.pageReferences(album.id) };
      this.publish({ busy: false, progress: null, pdfProgress: null, canvas: this.pages.snapshot(), album });
    }
  }

  /** 手动打开只接受原生对话框位置，成功与启动恢复共用完整载入流程。 */
  async chooseAlbum(create: boolean): Promise<AlbumResult<null>> {
    return this.run(async () => {
      if (!await this.guardDirty()) return undefined;
      const result = await dialog.showOpenDialog(this.getWindow(), {
        title: create ? '新建画册：请选择空目录' : '打开画册：请选择画册目录',
        properties: create ? ['openDirectory', 'createDirectory'] : ['openDirectory']
      });
      if (result.canceled || !result.filePaths[0]) return undefined;
      await this.openDirectory(result.filePaths[0], create);
      return null;
    });
  }

  /** 候选画册和第一页完整读取后才替换会话；最近记录写入失败不撤销成功打开。 */
  private async openDirectory(directory: string, create = false): Promise<void> {
    const store = new AlbumStore();
    const album = create ? await store.create(directory) : await store.open(directory);
    const pages = this.makePages(store);
    if (album.pages[0]) await pages.load(album.id, album.pages[0].id);
    this.assetImages.reset();
    this.store = store; this.pages = pages;
    this.publish({ album, notice: this.appData.warnings.join('\n') || null, canRetryLastAlbum: false });
    try { await this.appData.rememberAlbum((await store.project(album.id)).root, album.name); }
    catch (error) {
      this.publish({ notice: [this.state.notice, `画册已打开，但未能记住本次画册：${describeFileError(error)}`].filter(Boolean).join('\n') });
    }
  }

  /** 主进程启动时仅调用一次；先占用操作锁再读配置，避免覆盖用户刚打开的画册。 */
  async initialize(restore = true): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    await this.run(async () => {
      await this.appData.load();
      this.publish({ notice: this.appData.warnings.join('\n') || null });
      if (restore && this.appData.reopenLastAlbum && this.appData.lastAlbum) {
        this.publish({ canRetryLastAlbum: true });
        await this.openDirectory(this.appData.lastAlbum.directory);
      }
      return null;
    }, '无法自动打开上次画册，请重试或通过“打开画册”重新选择');
  }

  /** 设置入口复用操作锁；落盘失败保留原菜单勾选值，使用非阻塞提示。 */
  async setReopenLastAlbum(enabled: boolean): Promise<AlbumResult<null>> {
    return this.run(async () => { await this.appData.setReopenLastAlbum(enabled); return null; }, '软件设置保存失败');
  }

  /** 重试只接受主进程保存的位置；沿用未保存确认，不暴露任意路径打开接口。 */
  async retryLastAlbum(): Promise<AlbumResult<null>> {
    return this.run(async () => {
      if (!this.appData.lastAlbum || !await this.guardDirty()) return undefined;
      this.publish({ notice: this.appData.warnings.join('\n') || null });
      await this.openDirectory(this.appData.lastAlbum.directory);
      return null;
    }, '无法打开上次画册，请重试或重新选择');
  }

  /** 校验运行时参数，TypeScript 类型不能替代 IPC 边界检查。 */
  private assertArguments(id: unknown, path: unknown): asserts id is string {
    if (typeof id !== 'string' || typeof path !== 'string' || id !== this.state.album?.id) {
      throw new Error('当前画册已切换或素材参数无效，请重试。');
    }
  }

  /** 重新读取真实素材目录；扫描失败保留上次成功的树并给出错误提示。 */
  private async refresh(id: string): Promise<void> {
    this.publish({ album: await this.store.snapshot(id) });
  }

  /** 注册有限业务接口，所有调用复用现有主窗口来源校验。 */
  register(): void {
    ipcMain.handle('crop:begin', (event, target: CropTarget) => {
      this.assertSender(event);
      return this.run(async () => {
        if (!target) throw new Error('裁剪目标无效。');
        this.assertArguments(target.albumId, '');
        return this.cropImages.begin(target, this.store, this.pages);
      });
    });
    ipcMain.handle('crop:apply', (event, token: string, settings: CropSettings) => {
      this.assertSender(event);
      return this.run(async () => {
        const value = await this.cropImages.apply(token, settings, this.store, this.pages);
        if (value !== null && this.state.album) {
          this.assetImages.reset();
          await this.refresh(this.state.album.id).catch(error => this.publish({ notice: `素材已裁剪，列表刷新失败，请点击刷新：${describeFileError(error)}` }));
        }
        return value;
      }, undefined, true);
    });
    ipcMain.handle('crop:release', async (event, token: string) => {
      this.assertSender(event);
      if (typeof token !== 'string') return;
      await this.cropImages.release(token).catch(error => this.publish({ notice: `裁剪已关闭，源图临时副本清理失败：${describeFileError(error)}` }));
      this.updateMenu();
    });
    this.assetImages.install();
    ipcMain.handle('asset:image', (event, id: string, path: string, kind: 'preview' | 'thumbnail', requestId: string, retry?: boolean) => {
      this.assertSender(event);
      return this.assetImages.request(id, path, kind, requestId, retry);
    });
    ipcMain.handle('asset:release-image', (event, requestId: string) => {
      this.assertSender(event);
      if (typeof requestId === 'string') this.assetImages.release(requestId);
    });
    installPageImageProtocol((albumId, pageId, objectId) => this.pdf?.imagePath(albumId, pageId, objectId) ?? this.pages.imagePath(albumId, pageId, objectId));
    ipcMain.handle('album:export-pdf', event => { this.assertSender(event); return this.exportPdf(); });
    ipcMain.handle('album:cancel-pdf', event => { this.assertSender(event); this.cancelPdf(); });
    ipcMain.handle('album:print-page', event => {
      if (!this.pdf) throw new Error('当前没有 PDF 导出任务。');
      return this.pdf.printPage(event);
    });
    ipcMain.handle('album:get-state', event => { this.assertSender(event); return this.state; });
    ipcMain.handle('album:create', event => { this.assertSender(event); return this.chooseAlbum(true); });
    ipcMain.handle('album:open', event => { this.assertSender(event); return this.chooseAlbum(false); });
    ipcMain.handle('album:retry-last', event => { this.assertSender(event); return this.retryLastAlbum(); });
    ipcMain.handle('page:save', event => { this.assertSender(event); return this.savePage(); });
    ipcMain.handle('text:fonts', event => { this.assertSender(event); return getTextFonts(); });
    ipcMain.handle('page:text', (event, albumId: string, pageId: string, objectId: string | null, draft: TextDraft, position?: { xMm: number; yMm: number }) => {
      this.assertSender(event);
      return this.run(async () => {
        this.assertArguments(albumId, pageId);
        if (objectId !== null && typeof objectId !== 'string') throw new Error('文字对象参数无效。');
        return this.pages.putText(albumId, pageId, objectId, draft, position);
      });
    });
    ipcMain.handle('page:command', (event, albumId: string, command: string, pageId: string, value: unknown) => {
      this.assertSender(event);
      return this.run(async () => {
        this.assertArguments(albumId, pageId);
        if (command === 'move') {
          const move = value as { objectId: string; xMm: number; yMm: number };
          if (!move || typeof move.objectId !== 'string') throw new Error('图片移动参数无效。');
          this.pages.move(albumId, pageId, move.objectId, move.xMm, move.yMm);
        } else if (command === 'resize') {
          const resize = value as { objectId: string; geometry: ImageGeometry };
          if (!resize || typeof resize.objectId !== 'string') throw new Error('图片尺寸参数无效。');
          this.pages.resize(albumId, pageId, resize.objectId, resize.geometry);
        } else if (command === 'rotate') {
          const rotation = value as { objectId: string; angle: number };
          if (!rotation || typeof rotation.objectId !== 'string') throw new Error('旋转参数无效。');
          this.pages.rotate(albumId, pageId, rotation.objectId, rotation.angle);
        } else if (command === 'rename-object') {
          const rename = value as { objectId: string; name: string | null };
          if (!rename || typeof rename.objectId !== 'string') throw new Error('对象改名参数无效。');
          this.pages.renameObject(albumId, pageId, rename.objectId, rename.name);
        } else if (command === 'reorder-object') {
          const order = value as { objectId: string; targetIndex: number };
          if (!order || typeof order.objectId !== 'string') throw new Error('图层排序参数无效。');
          this.pages.reorderObject(albumId, pageId, order.objectId, order.targetIndex);
        } else if (command === 'orientation') {
          this.pages.setOrientation(albumId, pageId, value as Orientation);
        } else {
          if (!await this.guardDirty()) return undefined;
          if (command === 'create') {
            const options = value as { name: string; orientation: Orientation };
            if (!options) throw new Error('画布创建参数无效。');
            await this.pages.create(albumId, options.name, options.orientation);
          } else if (command === 'select') await this.pages.load(albumId, pageId);
          else if (command === 'rename') await this.pages.rename(albumId, pageId, value as string);
          else if (command === 'reorder') await this.pages.reorder(albumId, pageId, value as -1 | 1);
          else if (command === 'add-image') await this.pages.addImage(albumId, pageId, value as string);
          else if (command === 'delete-page' || command === 'delete-image') {
            const answer = await dialog.showMessageBox(this.getWindow(), { type: 'warning', title: '确认删除',
              message: command === 'delete-page' ? '删除此画布及其全部页面图片和文字？此操作会删除真实文件。' : '删除选中的图片或文字？图片同时删除本页副本，素材库原图保留。',
              buttons: ['取消', '删除'], defaultId: 0, cancelId: 0 });
            if (answer.response !== 1) return undefined;
            if (command === 'delete-image') await this.pages.deleteObject(albumId, pageId, value as string);
            else {
              const before = (await this.store.project(albumId)).manifest.pages;
              const index = before.findIndex(item => item.id === pageId);
              await this.pages.delete(albumId, pageId);
              const remaining = (await this.store.project(albumId)).manifest.pages;
              const next = remaining[Math.min(index, remaining.length - 1)];
              if (next) await this.pages.load(albumId, next.id);
            }
          } else throw new Error('未知画布操作。');
        }
        return null;
      });
    });
    ipcMain.handle('album:refresh', (event, id: string) => {
      this.assertSender(event);
      return this.run(async () => { this.assertArguments(id, ''); await this.refresh(id); return null; });
    });
    ipcMain.handle('album:create-group', (event, id: string, parent: string, name: string) => {
      this.assertSender(event);
      return this.run(async () => {
        this.assertArguments(id, parent);
        await this.store.createGroup(id, parent, name);
        try { await this.refresh(id); }
        catch (error) { throw new Error(`分组已创建，但列表刷新失败：${describeFileError(error)}请点击刷新。`); }
        return null;
      });
    });
    ipcMain.handle('album:delete-asset', (event, id: string, path: string, kind: AssetEntry['kind']) => {
      this.assertSender(event);
      return this.run(async () => {
        this.assertArguments(id, path);
        if (!path || !['directory', 'image'].includes(kind)) throw new Error('删除素材的目标无效，不能删除素材库根目录。');
        const group = kind === 'directory';
        if (!await this.dialogs.confirmAssetDeletion(path, group)) return undefined;
        this.assetImages.releasePath(id, path, group);
        try { await this.store.deleteAsset(id, path, kind); }
        catch (error) {
          // 系统失败后仍刷新真实目录；不改动当前画布草稿或请求保存。
          await this.refresh(id).catch(() => undefined);
          throw error;
        }
        try { await this.refresh(id); }
        catch (error) { throw new Error(`素材已移入回收站，但列表刷新失败：${describeFileError(error)}请点击刷新。`); }
        return null;
      });
    });
    ipcMain.handle('album:import', (event, id: string, target: string) => {
      this.assertSender(event);
      return this.run<ImportReport>(async () => {
        this.assertArguments(id, target);
        const selected = await dialog.showOpenDialog(this.getWindow(), {
          title: '导入图片到素材库', properties: ['openFile', 'multiSelections'],
          filters: [{ name: 'JPEG / PNG 图片', extensions: ['jpg', 'jpeg', 'png'] }, { name: '所有文件', extensions: ['*'] }]
        });
        if (selected.canceled || !selected.filePaths.length) return undefined;
        const validation = new ImageValidationTask();
        let report: ImportReport;
        try {
          report = await this.store.importImages(id, target, selected.filePaths,
            (path, format) => validation.validate(path, format), progress => this.publish({ progress }));
        } finally { validation.dispose(); }
        // 文件已经落盘时仍返回逐项结果，避免扫描错误掩盖实际导入情况。
        try { await this.refresh(id); }
        catch (error) { report.warnings.push(`图片已处理，但列表刷新失败：${describeFileError(error)}请点击刷新。`); }
        return report;
      });
    });
  }

  /** 仅用于开发冒烟验收，通过真实状态广播检查素材面板，不增加生产 IPC。 */
  async loadSmokeAlbum(directory: string): Promise<AlbumSnapshot> {
    const store = new AlbumStore();
    const album = await store.open(directory);
    const pages = this.makePages(store);
    if (album.pages[0]) await pages.load(album.id, album.pages[0].id);
    this.assetImages.reset();
    this.store = store; this.pages = pages;
    this.publish({ album });
    this.publish({ canvas: pages.snapshot() });
    return album;
  }

  /** 菜单和工具栏共用手动保存，失败保持 dirty，便于重试或取消关闭。 */
  async savePage(): Promise<AlbumResult<null>> {
    return this.run(async () => { await this.pages.save(); return null; });
  }

  /** 由桌面入口注入受限窗口工厂，测试和正式入口共用相同打印流程。 */
  configurePdf(create: () => BrowserWindow, load: (window: BrowserWindow) => Promise<void>): void {
    this.pdfWindows = { create, load };
  }

  /** 菜单和工具栏共用导出锁、保存确认和原生位置授权，不接收界面提供的绝对路径。 */
  async exportPdf(): Promise<AlbumResult<string>> {
    return this.run(async () => {
      const album = this.state.album;
      if (!album?.pages.length) throw new Error('请先打开画册并创建画布。');
      if (!this.pdfWindows) throw new Error('PDF 导出窗口尚未初始化。');
      const name = pdfFileName(album.name);
      if (this.pages.dirty) {
        const subject = album.pages.find(page => page.id === this.state.canvas?.pageId)?.name ?? '当前画布';
        const answer = await this.dialogs.confirmUnsaved(subject, true);
        if (answer !== 'save') return undefined;
        await this.pages.save();
      }
      const selected = await dialog.showSaveDialog(this.getWindow(), { title: '导出画册 PDF', defaultPath: name,
        filters: [{ name: 'PDF 文档', extensions: ['pdf'] }], properties: ['showOverwriteConfirmation'] });
      if (selected.canceled || !selected.filePath) return undefined;
      // 原生对话框可修改名称；补齐 PDF 后缀，日期建议名始终来自画册名称。
      const destination = /\.pdf$/iu.test(selected.filePath) ? selected.filePath : `${selected.filePath}.pdf`;
      if (destination !== selected.filePath) {
        const { lstat } = await import('node:fs/promises');
        const exists = await lstat(destination).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
        if (exists) {
          const answer = await dialog.showMessageBox(this.getWindow(), { type: 'warning', title: '确认覆盖 PDF',
            message: `文件已存在：${destination}`, buttons: ['取消', '覆盖'], defaultId: 0, cancelId: 0 });
          if (answer.response !== 1) return undefined;
        }
      }
      const task = new PdfExport(this.store, this.makePages(this.store), this.pdfWindows.create, this.pdfWindows.load,
        pdfProgress => this.publish({ pdfProgress }));
      this.pdf = task;
      try { return await task.run(album.id, destination, album.name) ? destination : undefined; }
      finally { this.pdf = null; }
    });
  }

  /** 取消绕过业务互斥，仅中断当前导出；发布阶段不能中断文件替换。 */
  cancelPdf(): void {
    this.pdf?.cancel();
    if (this.state.pdfProgress && this.state.pdfProgress.phase !== 'publishing') {
      this.publish({ pdfProgress: { ...this.state.pdfProgress, canceling: true } });
    }
  }

  /** 主窗口 close 事件先阻止退出，再确认草稿；业务进行中拒绝关闭。 */
  async canClose(): Promise<boolean> {
    if (this.state.busy || this.cropImages.active) return false;
    const result = await this.run(async () => await this.guardDirty());
    return result.status === 'success' && result.value;
  }

  /** 主窗口关闭后释放浏览租约和后台图片任务。 */
  dispose(): void { this.cancelPdf(); this.assetImages.reset(); void this.releaseCrop(); }

  /** 主窗口重载时撤销孤立裁剪弹框，允许恢复正常菜单操作。 */
  async releaseCrop(): Promise<void> {
    await this.cropImages.release().catch(error => this.publish({ notice: `裁剪临时副本清理失败：${describeFileError(error)}` }));
    this.updateMenu();
  }
}
