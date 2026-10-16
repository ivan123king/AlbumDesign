/** 文件用途：声明 preload 提供的有限桌面接口，不给渲染进程开放 Node.js。 */
import type { DesktopApi } from '../../shared/framework';

declare global {
  interface Window { desktop: DesktopApi; }
}

export {};
