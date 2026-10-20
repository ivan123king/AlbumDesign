/** 文件用途：定义框架样例类型并整合受限桌面接口，真实画册模型独立维护。 */
import type { AlbumApi } from './album';
export type Orientation = 'portrait' | 'landscape';

export interface PreviewPage {
  id: string;
  name: string;
  orientation: Orientation;
}

export interface AppInfo {
  version: string;
  electron: string;
  chromium: string;
}

/** 主进程持有一次性请求 ID；界面只能回应当前弹窗，不能提交任意删除目标。 */
export type AppDialogRequest =
  | { id: string; kind: 'warning'; title: string; subject: string; message: string }
  | { id: string; kind: 'unsaved'; subject: string; exportOnly: boolean }
  | { id: string; kind: 'about' };
export type UnsavedChoice = 'save' | 'discard' | 'cancel';
export type AppDialogResponse = boolean | UnsavedChoice;
export interface AppDialogState { revision: number; request: AppDialogRequest | null }

/** 只提供明确业务方法，不暴露通用 IPC 或文件系统能力。 */
export interface DesktopApi extends AlbumApi {
  getAppInfo(): Promise<AppInfo>;
  getAppDialog(): Promise<AppDialogState>;
  respondAppDialog(id: string, response: AppDialogResponse): Promise<boolean>;
  onAppDialog(listener: (state: AppDialogState) => void): () => void;
}

/** 样例仅用于检验 A4 方向、分页和文字，不作为真实工程数据。 */
export const previewPages: readonly PreviewPage[] = [
  { id: 'preview-portrait', name: '竖版预览', orientation: 'portrait' },
  { id: 'preview-landscape', name: '横版预览', orientation: 'landscape' }
];

/** 返回 A4 物理尺寸，单位始终为毫米，查看缩放不修改此值。 */
export function getPageSize(orientation: Orientation): { width: number; height: number } {
  return orientation === 'portrait' ? { width: 210, height: 297 } : { width: 297, height: 210 };
}
