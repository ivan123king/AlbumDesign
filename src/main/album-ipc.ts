/** 文件用途：串行执行画册操作，通过原生对话框授权外部路径并广播素材状态。 */
import { dialog, ipcMain, Menu } from 'electron';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { AlbumStore, describeFileError } from './album-store';
import { ImageValidationTask } from './image-validator';
import { installPageImageProtocol } from './image-validator';
import { PageStore } from './page-store';
import type { Orientation } from '../shared/framework';
import type { ImageGeometry } from '../shared/canvas';
import type { AlbumResult, AlbumSnapshot, AlbumState, ImportReport } from '../shared/album';

/** 主菜单与 preload 共用控制器，避免并行导入和切换画册造成错写。 */
export class AlbumController {
  private store = new AlbumStore();
  private pages = this.makePages(this.store);
  private state: AlbumState = { revision: 0, album: null, busy: false, progress: null, canvas: null };

  constructor(private readonly getWindow: () => BrowserWindow,
    private readonly assertSender: (event: IpcMainInvokeEvent) => void) {}

  /** 每次广播增加版本号，界面能忽略初始化期间晚到的旧快照。 */
  private publish(change: Partial<AlbumState>): void {
    this.state = { ...this.state, ...change, revision: this.state.revision + 1 };
    const window = this.getWindow();
    if (!window.isDestroyed()) window.webContents.send('album:state', this.state);
    for (const id of ['create-album', 'open-album']) {
      const item = Menu.getApplicationMenu()?.getMenuItemById(id);
      if (item) item.enabled = !this.state.busy;
    }
    const save = Menu.getApplicationMenu()?.getMenuItemById('save-page');
    if (save) save.enabled = !this.state.busy && !!this.state.canvas?.dirty;
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
    const answer = await dialog.showMessageBox(this.getWindow(), { type: 'question', title: '画布有未保存修改',
      message: '是否保存当前画布的位置、尺寸与方向修改？', buttons: ['保存', '放弃修改', '取消'], defaultId: 0, cancelId: 2 });
    if (answer.response === 2) return false;
    if (answer.response === 0) await this.pages.save(); else this.pages.discard();
    return true;
  }

  /** 忙碌时直接拒绝；取消与失败分别返回，错误同时通过系统对话框反馈。 */
  private async run<T>(operation: () => Promise<T | undefined>): Promise<AlbumResult<T>> {
    if (this.state.busy) return { status: 'error', message: '正在处理画册操作，请稍候。' };
    this.publish({ busy: true, progress: null });
    try {
      const value = await operation();
      return value === undefined ? { status: 'canceled' } : { status: 'success', value };
    } catch (error) {
      const message = describeFileError(error);
      await dialog.showMessageBox(this.getWindow(), { type: 'error', title: '画册操作失败', message });
      return { status: 'error', message };
    } finally {
      let album = this.state.album;
      if (album) album = { ...album, pages: this.store.pageReferences(album.id) };
      this.publish({ busy: false, progress: null, canvas: this.pages.snapshot(), album });
    }
  }

  /** 画册位置只能由原生目录对话框选择，不接收渲染进程传入的磁盘路径。 */
  async chooseAlbum(create: boolean): Promise<AlbumResult<null>> {
    return this.run(async () => {
      if (!await this.guardDirty()) return undefined;
      const result = await dialog.showOpenDialog(this.getWindow(), {
        title: create ? '新建画册：请选择空目录' : '打开画册：请选择画册目录',
        properties: create ? ['openDirectory', 'createDirectory'] : ['openDirectory']
      });
      if (result.canceled || !result.filePaths[0]) return undefined;
      // 候选会话完整载入后再替换旧会话，损坏画布不会使原画册失效。
      const store = new AlbumStore();
      const album = create ? await store.create(result.filePaths[0]) : await store.open(result.filePaths[0]);
      const pages = this.makePages(store);
      if (album.pages[0]) await pages.load(album.id, album.pages[0].id);
      this.store = store; this.pages = pages;
      this.publish({ album });
      return null;
    });
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
    installPageImageProtocol((albumId, pageId, objectId) => this.pages.imagePath(albumId, pageId, objectId));
    ipcMain.handle('album:get-state', event => { this.assertSender(event); return this.state; });
    ipcMain.handle('album:create', event => { this.assertSender(event); return this.chooseAlbum(true); });
    ipcMain.handle('album:open', event => { this.assertSender(event); return this.chooseAlbum(false); });
    ipcMain.handle('page:save', event => { this.assertSender(event); return this.savePage(); });
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
              message: command === 'delete-page' ? '删除此画布及其全部页面图片？此操作会删除真实文件。' : '删除此图片及本页副本？素材库原图保留。',
              buttons: ['取消', '删除'], defaultId: 0, cancelId: 0 });
            if (answer.response !== 1) return undefined;
            if (command === 'delete-image') await this.pages.deleteImage(albumId, pageId, value as string);
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
    this.store = store; this.pages = pages;
    this.publish({ album });
    this.publish({ canvas: pages.snapshot() });
    return album;
  }

  /** 菜单和工具栏共用手动保存，失败保持 dirty，便于重试或取消关闭。 */
  async savePage(): Promise<AlbumResult<null>> {
    return this.run(async () => { await this.pages.save(); return null; });
  }

  /** 主窗口 close 事件先阻止退出，再确认草稿；业务进行中拒绝关闭。 */
  async canClose(): Promise<boolean> {
    if (this.state.busy) return false;
    const result = await this.run(async () => await this.guardDirty());
    return result.status === 'success' && result.value;
  }
}
