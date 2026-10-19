/** 文件用途：定义真实画册 PDF 的受限打印数据、任务进度及文件命名规则。 */
import type { CanvasDocument } from './canvas';

export interface PdfPrintPage { albumId: string; pageId: string; document: CanvasDocument }
export interface PdfProgress {
  phase: 'preparing' | 'printing' | 'merging' | 'publishing';
  completed: number;
  total: number;
  canceling: boolean;
}

/** 使用开始导出时的本机日期；名称仅用于文件名，不允许路径或 Windows 非法字符。 */
export function pdfFileName(name: string, date = new Date()): string {
  const safe = name.trim();
  if (!safe || /[<>:"/\\|?*\u0000-\u001f]/u.test(safe) || /[. ]$/u.test(safe)) {
    throw new Error('画册名称不能用作 Windows 文件名，请检查名称中的特殊字符或末尾的点。');
  }
  const day = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
  return `${safe}-${day}.pdf`;
}
