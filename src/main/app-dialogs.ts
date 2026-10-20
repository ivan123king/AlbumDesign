/** 文件用途：协调告警、未保存确认与关于弹框，保留业务锁和一次性响应，界面重载时取消。 */
import { ipcMain } from 'electron';
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import type { AppDialogResponse, AppDialogState, UnsavedChoice } from '../shared/framework';

/** 仅承载明确的三类业务弹框，不向渲染进程开放通用命令执行。 */
export class AppDialogs {
  private state: AppDialogState = { revision: 0, request: null };
  private resolvePending: ((response: AppDialogResponse) => void) | null = null;

  constructor(private readonly getWindow: () => BrowserWindow | null,
    private readonly assertSender: (event: IpcMainInvokeEvent) => void,
    private readonly onChange: () => void) {}

  get isOpen(): boolean { return this.state.request !== null; }

  /** 版本号防止初始查询晚于事件时恢复已经关闭的弹窗。 */
  private publish(request: AppDialogState['request']): void {
    this.state = { revision: this.state.revision + 1, request };
    const window = this.getWindow();
    if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('app:dialog-state', this.state);
    this.onChange();
  }

  /** 关闭只完成当前请求；按弹框类型校验响应，导出确认不能选择放弃。 */
  private finish(id: unknown, response: unknown): boolean {
    const request = this.state.request;
    if (typeof id !== 'string' || !request || request.id !== id) return false;
    if (request.kind === 'unsaved') {
      if (!['save', 'discard', 'cancel'].includes(response as string) || (request.exportOnly && response === 'discard')) return false;
    } else if (typeof response !== 'boolean') return false;
    const resolve = this.resolvePending;
    this.resolvePending = null;
    this.publish(null);
    resolve?.(response as AppDialogResponse);
    return true;
  }

  /** 主窗口订阅受限状态；导航、渲染进程异常与销毁一律按取消处理，不悬挂业务操作。 */
  register(window: BrowserWindow): void {
    ipcMain.handle('app:get-dialog', event => { this.assertSender(event); return this.state; });
    ipcMain.handle('app:respond-dialog', (event, id: unknown, response: unknown) => {
      this.assertSender(event);
      return this.finish(id, response);
    });
    const cancel = (): void => { if (this.state.request) this.finish(this.state.request.id, this.state.request.kind === 'unsaved' ? 'cancel' : false); };
    window.webContents.on('did-start-loading', cancel);
    window.webContents.on('render-process-gone', cancel);
    window.webContents.on('destroyed', cancel);
  }

  /** 删除事务持锁等待界面确认；已有弹窗时取消新请求，绝不覆盖待确认目标。 */
  confirmAssetDeletion(path: string, group: boolean): Promise<boolean> {
    if (this.isOpen) return Promise.resolve(false);
    return new Promise(resolve => {
      this.resolvePending = response => resolve(response === true);
      this.publish({ id: randomUUID(), kind: 'warning', title: group ? '删除素材分组' : '删除素材', subject: path,
        message: `${group ? '该分组及其中的全部子分组和文件' : '该素材文件'}将移入回收站。` });
    });
  }

  /** 离页/关闭提供保存、放弃、取消；导出仅提供保存并导出与取消，重载一律取消。 */
  confirmUnsaved(subject: string, exportOnly = false): Promise<UnsavedChoice> {
    if (this.isOpen) return Promise.resolve('cancel');
    return new Promise(resolve => {
      this.resolvePending = response => resolve(typeof response === 'string' ? response : 'cancel');
      this.publish({ id: randomUUID(), kind: 'unsaved', subject, exportOnly });
    });
  }

  /** 关于窗口由原生菜单请求，重复点击不叠加，也不覆盖删除告警。 */
  showAbout(): void {
    if (!this.isOpen) this.publish({ id: randomUUID(), kind: 'about' });
  }
}
