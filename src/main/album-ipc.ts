/** 文件用途：串行执行画册操作，通过原生对话框授权外部路径并广播素材状态。 */
import { dialog, ipcMain, Menu } from 'electron';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { AlbumStore, describeFileError } from './album-store';
import { ImageValidationTask } from './image-validator';
import type { AlbumResult, AlbumSnapshot, AlbumState, ImportReport } from '../shared/album';

/** 主菜单与 preload 共用控制器，避免并行导入和切换画册造成错写。 */
export class AlbumController {
  private readonly store = new AlbumStore();
  private state: AlbumState = { revision: 0, album: null, busy: false, progress: null };

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
    } finally { this.publish({ busy: false, progress: null }); }
  }

  /** 画册位置只能由原生目录对话框选择，不接收渲染进程传入的磁盘路径。 */
  async chooseAlbum(create: boolean): Promise<AlbumResult<null>> {
    return this.run(async () => {
      const result = await dialog.showOpenDialog(this.getWindow(), {
        title: create ? '新建画册：请选择空目录' : '打开画册：请选择画册目录',
        properties: create ? ['openDirectory', 'createDirectory'] : ['openDirectory']
      });
      if (result.canceled || !result.filePaths[0]) return undefined;
      const album = create ? await this.store.create(result.filePaths[0]) : await this.store.open(result.filePaths[0]);
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
    ipcMain.handle('album:get-state', event => { this.assertSender(event); return this.state; });
    ipcMain.handle('album:create', event => { this.assertSender(event); return this.chooseAlbum(true); });
    ipcMain.handle('album:open', event => { this.assertSender(event); return this.chooseAlbum(false); });
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
    const album = await this.store.open(directory);
    this.publish({ album });
    return album;
  }
}
