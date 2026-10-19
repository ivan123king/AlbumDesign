/** 文件用途：在工作线程逐页合并 Chromium PDF，保留字体和图片，避免计算阻塞主进程。 */
import { parentPort, workerData } from 'node:worker_threads';
import { readFile, writeFile } from 'node:fs/promises';
import { PDFDocument } from 'pdf-lib';

/** 只接收主进程生成的临时路径；每份输入必须恰好一页竖向 A4，不接受意外空白分页。 */
async function merge(): Promise<void> {
  const { files, output, title } = workerData as { files: string[]; output: string; title: string };
  const document = await PDFDocument.create();
  document.setTitle(title); document.setCreator('画册工坊');
  for (let index = 0; index < files.length; index++) {
    const source = await PDFDocument.load(await readFile(files[index]!));
    if (source.getPageCount() !== 1) throw new Error(`第 ${index + 1} 页产生了额外分页，已停止导出。`);
    const page = source.getPage(0); const size = page.getSize();
    if (Math.abs(size.width - 210 / 25.4 * 72) > 1 || Math.abs(size.height - 297 / 25.4 * 72) > 1 || page.getRotation().angle !== 0) {
      throw new Error(`第 ${index + 1} 页不是无旋转标记的竖向 A4。`);
    }
    const [copy] = await document.copyPages(source, [0]);
    // Chromium 的毫米纸张会按内部像素取整；校正纸张框到精确 A4，不缩放对象内容。
    copy!.setMediaBox(0, 0, 210 / 25.4 * 72, 297 / 25.4 * 72);
    copy!.setCropBox(0, 0, 210 / 25.4 * 72, 297 / 25.4 * 72);
    document.addPage(copy!);
    parentPort!.postMessage({ completed: index + 1 });
  }
  await writeFile(output, await document.save(), { flag: 'wx' });
}

void merge().then(() => parentPort!.postMessage({ done: true }))
  .catch(error => { parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) }); process.exitCode = 1; });
