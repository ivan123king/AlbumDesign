/** 文件用途：仅开发模式运行真实 Electron 冒烟验证，生成报告、截图和双页 PDF。 */
import type { BrowserWindow } from 'electron';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** 在真实 Chromium 中验证桥接、隔离、空画册界面、缩放、侧栏与窗口适配。 */
export async function runFrameworkSmoke(
  window: BrowserWindow,
  output: string,
  exportPdf: (filePath: string) => Promise<void>
): Promise<void> {
  await mkdir(output, { recursive: true });
  const result = await window.webContents.executeJavaScript(`(async () => {
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const wait = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    for (let i = 0; !document.querySelector('[data-app-ready]'); i++) {
      check(i < 200, '界面初始化超时');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const info = await window.desktop.getAppInfo();
    check(info.electron && info.version, 'preload 通信失败');
    check(typeof window.require === 'undefined' && typeof window.process === 'undefined', 'Node 隔离失败');
    check(document.querySelector('[data-no-page]') && !document.querySelector('[data-paper]'), '未打开画册时不应显示业务页面');
    document.querySelector('[data-zoom-in]').click();
    await wait();
    check(Number(document.querySelector('[data-zoom-value]').dataset.zoomValue) > 0.65, '缩放按钮无效');
    const zoomBeforeWheel = Number(document.querySelector('[data-zoom-value]').dataset.zoomValue);
    document.querySelector('[data-workspace]').dispatchEvent(new WheelEvent('wheel', {deltaY:-100, bubbles:true, cancelable:true}));
    await wait();
    check(Number(document.querySelector('[data-zoom-value]').dataset.zoomValue) > zoomBeforeWheel, '滚轮缩放无效');
    const divider = document.querySelector('[data-divider="left"]');
    const originalWidth = document.querySelector('[data-left-panel]').getBoundingClientRect().width;
    divider.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowRight', bubbles:true}));
    await wait();
    check(document.querySelector('[data-left-panel]').getBoundingClientRect().width > originalWidth, '侧栏宽度调整失败');
    check(!document.querySelector('[data-new-project]').disabled, '新建画册入口未启用');
    check(document.querySelector('[data-fit-page]').disabled, '没有画布时适应窗口应禁用');
    return {info, isolation:true, emptyState:true, zoom:true, wheelZoom:true, panelResize:true};
  })()`);
  await writeFile(join(output, 'desktop.png'), (await window.webContents.capturePage()).toPNG());
  window.setSize(1000, 680);
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await window.webContents.executeJavaScript("document.querySelector('[data-fit-page]').click(); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  const fits = await window.webContents.executeJavaScript('document.documentElement.scrollWidth <= window.innerWidth');
  if (!fits) throw new Error('最小窗口宽度下出现全局横向溢出。');
  await writeFile(join(output, 'compact.png'), (await window.webContents.capturePage()).toPNG());
  await exportPdf(join(output, 'A4-sample.pdf'));
  await writeFile(join(output, 'report.json'), JSON.stringify({ ...result, compactLayout: true, pdfGenerated: true }, null, 2));
  console.log('Electron 冒烟验证通过，结果位于 .cache/verification。');
}
