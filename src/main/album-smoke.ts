/** 文件用途：只在临时画册中验证素材文件安全、真实图片解码及隔离界面交互。 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { dialog, nativeImage } from 'electron';
import type { BrowserWindow } from 'electron';
import { AlbumStore } from './album-store';
import { ImageValidationTask } from './image-validator';
import type { AlbumController } from './album-ipc';

/** 在真实 Chromium 中等待状态，不依赖固定长延时。 */
async function waitFor(window: BrowserWindow, expression: string): Promise<void> {
  await window.webContents.executeJavaScript(`(async () => {
    for (let i = 0; !(${expression}); i++) {
      if (i > 200) throw new Error('素材界面等待超时：' + ${JSON.stringify(expression)});
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  })()`);
}

/** DOM 提交后再等待合成器绘制，避免隐藏窗口截图停留在前一次操作画面。 */
async function capture(window: BrowserWindow, path: string): Promise<void> {
  await window.webContents.executeJavaScript(`new Promise(resolve => {
    setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(resolve)), 120);
  })`);
  await writeFile(path, (await window.webContents.capturePage()).toPNG());
}

/** 原图和异常数据均由测试创建；保留临时目录便于复核，不触碰用户真实画册。 */
export async function runAlbumSmoke(window: BrowserWindow, output: string, controller: AlbumController): Promise<void> {
  window.setSize(1440, 960);
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const temporaryRoot = await mkdtemp(join(output, '素材验收-'));
  const albumPath = join(temporaryRoot, '中文画册');
  const sourcePath = join(temporaryRoot, '外部原图');
  const otherPath = join(temporaryRoot, '另一份原图');
  await Promise.all([mkdir(albumPath), mkdir(sourcePath), mkdir(otherPath)]);
  const image = nativeImage.createFromBitmap(Buffer.from([
    20, 80, 180, 255, 20, 80, 180, 255, 20, 80, 180, 255, 20, 80, 180, 255
  ]), { width: 2, height: 2 });
  const jpg = image.toJPEG(90);
  const png = image.toPNG();
  const photo = join(sourcePath, '照片.JPG');
  const secondPhoto = join(otherPath, '照片.JPG');
  const graphic = join(sourcePath, '透明图.png');
  const unsupported = join(sourcePath, '不支持.bmp');
  const wrongFormat = join(sourcePath, '改后缀.jpg');
  const damaged = join(sourcePath, '损坏.png');
  await Promise.all([
    writeFile(photo, jpg), writeFile(secondPhoto, jpg), writeFile(graphic, png),
    writeFile(unsupported, png), writeFile(wrongFormat, png),
    writeFile(damaged, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]))
  ]);

  const store = new AlbumStore();
  const initial = await store.create(albumPath);
  assert.equal(initial.imageCount, 0);
  const originalManifest = await readFile(join(albumPath, 'project.json'), 'utf8');
  assert.equal(JSON.parse(originalManifest).nextPageNumber, 1);
  await assert.rejects(store.create(albumPath), /空目录/u);
  assert.equal((await store.snapshot()).id, initial.id);
  await store.createGroup(initial.id, '', '旅行');
  await store.createGroup(initial.id, '旅行', '第一天');
  await assert.rejects(store.createGroup(initial.id, '', '旅行'), { code: 'EEXIST' });
  for (const invalid of ['../越界', 'CON', 'LPT¹.png', '末尾.', '末尾 ', '含:冒号', '']) {
    await assert.rejects(store.createGroup(initial.id, '', invalid));
  }
  for (const invalid of ['../', '.. ', '旅行/.. ', 'C:/Windows', '旅行\\第一天', '/旅行']) {
    await assert.rejects(store.createGroup(initial.id, invalid, '越界'));
  }
  await assert.rejects(store.createGroup('旧会话', '', '错误位置'), /切换/u);

  const validator = new ImageValidationTask();
  const progress: number[] = [];
  try {
    const report = await store.importImages(initial.id, '旅行/第一天', [photo, graphic, secondPhoto, unsupported,
      wrongFormat, damaged, join(sourcePath, '不存在.jpg')], (path, format) => validator.validate(path, format), value => progress.push(value.completed));
    assert.equal(report.succeeded.length, 3, JSON.stringify(report));
    assert.equal(report.failed.length, 4, JSON.stringify(report));
    assert.equal(report.warnings.length, 0);
    assert.equal(progress.at(-1), 7);
    assert.equal(report.succeeded[2]?.savedPath, '旅行/第一天/照片 (1).JPG');
    assert.deepEqual(await readFile(join(albumPath, 'assets', '旅行', '第一天', '照片.JPG')), jpg);
    assert.deepEqual(await readFile(photo), jpg);
    assert.deepEqual(await readFile(graphic), png);
    const repeated = await store.importImages(initial.id, '旅行/第一天', [photo],
      (path, format) => validator.validate(path, format), () => undefined);
    assert.equal(repeated.succeeded[0]?.savedPath, '旅行/第一天/照片 (2).JPG');
    // 模拟校验阶段失败，确认失败临时副本已删除且原图仍在。
    const interrupted = await store.importImages(initial.id, '', [photo], async () => { throw new Error('模拟后台失败'); }, () => undefined);
    assert.equal(interrupted.failed.length, 1);
    assert.equal(interrupted.succeeded.length, 0);
    assert.deepEqual(await readdir(join(albumPath, 'assets', '旅行', '第一天')), ['照片 (1).JPG', '照片 (2).JPG', '照片.JPG', '透明图.png'].sort());
    assert(!(await readdir(join(albumPath, 'assets'))).some(name => name.endsWith('.tmp')));
  } finally { validator.dispose(); }

  // Windows 目录联接不需要创建普通符号链接的管理员权限。
  await symlink(sourcePath, join(albumPath, 'assets', '外部链接'), 'junction');
  await assert.rejects(store.createGroup(initial.id, '外部链接', '不得写入'));
  assert.equal((await store.snapshot()).warnings.length, 1);
  const brokenAlbum = join(temporaryRoot, '损坏画册');
  await mkdir(brokenAlbum);
  await writeFile(join(brokenAlbum, 'project.json'), '{ broken');
  await assert.rejects(store.open(brokenAlbum), /损坏/u);
  assert.equal((await store.snapshot()).id, initial.id);
  await writeFile(join(brokenAlbum, 'project.json'), JSON.stringify({ formatVersion: 99 }));
  await assert.rejects(store.open(brokenAlbum), /版本/u);
  const wrongCounter = JSON.parse(originalManifest);
  wrongCounter.pages = [{ id: 'page-1', name: '第 1 页', directoryName: '001' }];
  await writeFile(join(brokenAlbum, 'project.json'), JSON.stringify(wrongCounter));
  await assert.rejects(store.open(brokenAlbum), /编号/u);
  assert.equal(await readFile(join(albumPath, 'project.json'), 'utf8'), originalManifest);

  const movedAlbum = join(temporaryRoot, '搬迁后的画册');
  await rename(albumPath, movedAlbum);
  const reopened = await new AlbumStore().open(movedAlbum);
  assert.equal(reopened.imageCount, 4);
  assert.equal(reopened.name, '中文画册');
  assert(reopened.id !== initial.id);
  await controller.loadSmokeAlbum(movedAlbum);
  await waitFor(window, "document.querySelector('[data-asset-count]')?.textContent === '4'");
  await window.webContents.executeJavaScript("document.querySelector('[data-asset-directory=\"旅行\"]').click()");
  await waitFor(window, "document.querySelector('[data-asset-directory=\"旅行/第一天\"]')");
  await window.webContents.executeJavaScript("document.querySelector('[data-asset-directory=\"旅行/第一天\"]').click()");
  await waitFor(window, "document.querySelectorAll('[data-asset-file]').length === 4");

  // 原生文件选择仅替换返回值，真实 IPC、后台解码、磁盘复制和界面状态仍完整运行。
  const originalPicker = dialog.showOpenDialog;
  const originalMessageBox = dialog.showMessageBox;
  let selectedFiles = [photo, damaged];
  let canceled = false;
  const operationErrors: string[] = [];
  dialog.showOpenDialog = (async () => ({ canceled, filePaths: selectedFiles })) as typeof dialog.showOpenDialog;
  dialog.showMessageBox = (async (...args: unknown[]) => {
    const options = args[1] as { message: string };
    operationErrors.push(options.message);
    return { response: 0, checkboxChecked: false };
  }) as typeof dialog.showMessageBox;
  try {
    await window.webContents.executeJavaScript("document.querySelector('.import-button').click()");
    await waitFor(window, "document.querySelector('.import-report summary')?.textContent?.includes('成功 1，失败 1')");
    assert.equal((await window.webContents.executeJavaScript('window.desktop.getAlbumState()')).album.imageCount, 5);
    assert.deepEqual(await readFile(join(movedAlbum, 'assets', '旅行', '第一天', '照片 (3).JPG')), jpg);
    canceled = true;
    selectedFiles = [];
    const cancelResult = await window.webContents.executeJavaScript(`(async () => {
      const state = await window.desktop.getAlbumState();
      return window.desktop.importAssets(state.album.id, '旅行/第一天');
    })()`);
    assert.equal(cancelResult.status, 'canceled');
    assert.equal((await window.webContents.executeJavaScript('window.desktop.getAlbumState()')).album.imageCount, 5);
    canceled = false;
    selectedFiles = [movedAlbum];
    const invalidCreate = await window.webContents.executeJavaScript('window.desktop.createAlbum()');
    assert.equal(invalidCreate.status, 'error');
    assert(operationErrors.at(-1)?.includes('空目录'));
    assert.equal((await window.webContents.executeJavaScript('window.desktop.getAlbumState()')).album.imageCount, 5);
    const ipcAlbum = join(temporaryRoot, '接口新建画册');
    await mkdir(ipcAlbum);
    selectedFiles = [ipcAlbum];
    const createdViaIpc = await window.webContents.executeJavaScript('window.desktop.createAlbum()');
    assert.equal(createdViaIpc.status, 'success');
    assert.equal((await window.webContents.executeJavaScript('window.desktop.getAlbumState()')).album.imageCount, 0);
    selectedFiles = [movedAlbum];
    assert.equal((await window.webContents.executeJavaScript('window.desktop.openAlbum()')).status, 'success');
    await waitFor(window, "document.querySelector('[data-asset-count]')?.textContent === '5'");
  } finally { dialog.showOpenDialog = originalPicker; dialog.showMessageBox = originalMessageBox; }

  await window.webContents.executeJavaScript("document.querySelector('[data-asset-directory=\"旅行\"]').click()");
  await waitFor(window, "document.querySelector('[data-asset-directory=\"旅行/第一天\"]')");
  await window.webContents.executeJavaScript("document.querySelector('[data-asset-directory=\"旅行/第一天\"]').click()");

  await window.webContents.executeJavaScript("document.querySelector('.asset-actions button').click()");
  await waitFor(window, "document.querySelector('.group-dialog[open]')");
  await window.webContents.executeJavaScript(`(() => {
    const input = document.querySelector('#group-name');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '界面创建');
    input.dispatchEvent(new Event('input', {bubbles:true}));
  })()`);
  await waitFor(window, "!document.querySelector('.group-dialog button[type=submit]').disabled");
  await capture(window, join(output, 'assets-group-dialog.png'));
  await window.webContents.executeJavaScript("document.querySelector('.group-dialog button[type=submit]').click()");
  await waitFor(window, "!document.querySelector('.group-dialog') && document.querySelector('[data-asset-directory=\"旅行/第一天/界面创建\"]')");
  await mkdir(join(movedAlbum, 'assets', '外部新增'));
  await window.webContents.executeJavaScript("document.querySelectorAll('.asset-actions button')[1].click()");
  await waitFor(window, "document.querySelector('[data-asset-directory=\"外部新增\"]')");
  await waitFor(window, "document.querySelector('.assets-panel').getAttribute('aria-busy') === 'false'");
  await window.webContents.executeJavaScript("document.querySelector('[data-asset-root]').click()");
  await waitFor(window, "document.querySelector('[data-asset-root]').getAttribute('aria-pressed') === 'true'");
  await capture(window, join(output, 'assets-desktop.png'));
  window.setSize(1000, 680);
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  assert(await window.webContents.executeJavaScript('document.documentElement.scrollWidth <= window.innerWidth'));
  await capture(window, join(output, 'assets-compact.png'));
  await writeFile(join(output, 'assets-report.json'), JSON.stringify({
    temporaryAlbum: relative(output, movedAlbum), createAndReopen: true, copiedBytesMatch: true,
    duplicatePreservesOriginal: true, damagedAndUnsupportedRejected: true, partialFailureCleaned: true,
    pathAndJunctionRejected: true, invalidManifestPreservesSession: true, movedAlbumReopens: true,
    realIpcCreateOpenImportAndCancel: true, groupDialogAndRefresh: true, compactLayout: true,
    nativeFilePickerManuallyVerified: false
  }, null, 2));
  console.log('素材验收通过：临时画册、真实后台解码、IPC 与界面交互已验证。');
}
