/** 文件用途：定义框架预览与有限进程通信的共享类型，不包含持久化业务。 */
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

export interface SamplePdfResult {
  canceled: boolean;
  filePath?: string;
}

/** 只提供明确业务方法，不暴露通用 IPC 或文件系统能力。 */
export interface DesktopApi {
  getAppInfo(): Promise<AppInfo>;
  exportSamplePdf(): Promise<SamplePdfResult>;
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
