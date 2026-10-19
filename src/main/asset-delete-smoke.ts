/** 文件用途：仅在临时画册中验收素材右键删除、目录安全、回收站失败及已有画布副本保留。 */
import assert from 'node:assert/strict';
import { copyFile, lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { dialog, Menu, nativeImage, net, shell } from 'electron';
import type { BrowserWindow, MessageBoxOptions } from 'electron';
import type { AlbumState, AssetEntry, AlbumResult } from '../shared/album';
import { AlbumStore } from './album-store';
import type { AlbumController } from './album-ipc';

/** 仅等待具体界面条件，超时报告表达式。 */
async function waitFor(window: BrowserWindow, expression: string): Promise<void> {
  await window.webContents.executeJavaScript(`(async () => {
    for (let i = 0; !(${expression}); i++) {
      if (i > 240) throw new Error('素材删除等待超时：' + ${JSON.stringify(expression)});
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  })()`);
}

/** 通过 Chromium 鼠标输入打开真实右键菜单，菜单可见前滚动目标到视口内。 */
async function rightClick(window: BrowserWindow, selector: string): Promise<void> {
  const point = await window.webContents.executeJavaScript(`(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!target) throw new Error('未找到右击目标');
    target.scrollIntoView({block:'center'});
    const bounds = target.getBoundingClientRect();
    return { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) };
  })()`);
  window.webContents.sendInputEvent({ type: 'mouseDown', button: 'right', clickCount: 1, ...point });
  window.webContents.sendInputEvent({ type: 'mouseUp', button: 'right', clickCount: 1, ...point });
  await waitFor(window, "document.querySelector('[data-asset-context-menu]')");
}

/** 截图前等待绘制，保留右键菜单及删除后的画布供人工复核。 */
async function capture(window: BrowserWindow, path: string): Promise<void> {
  await window.webContents.executeJavaScript('new Promise(resolve => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(resolve)), 120))');
  await writeFile(path, (await window.webContents.capturePage()).toPNG());
}

/** 确认真实 HTML 告警，不替换删除结果；主进程仍持锁等待一次性响应。 */
async function confirmWarning(window: BrowserWindow): Promise<void> {
  await waitFor(window, "document.querySelector('[data-app-dialog=warning][open]')");
  await window.webContents.executeJavaScript("document.querySelector('[data-app-dialog-confirm]').click()");
}

/** 临时工程中的素材真实送入回收站；系统失败注入仅作用于本次测试，不操作真实用户画册。 */
export async function runAssetDeleteSmoke(window: BrowserWindow, output: string, controller: AlbumController): Promise<void> {
  await mkdir(output, { recursive: true });
  const temporary = await mkdtemp(join(output, '素材删除验收-'));
  const root = join(temporary, '临时画册');
  await mkdir(root);
  const store = new AlbumStore();
  const initial = await store.create(root);
  const bytes = nativeImage.createFromBitmap(Buffer.from([60, 120, 180, 255]), { width: 1, height: 1 }).toPNG();
  const source = join(temporary, '外部原图.png');
  await writeFile(source, bytes);
  await mkdir(join(root, 'assets', '待删分组', '子分组'), { recursive: true });
  await mkdir(join(root, 'assets', '待删分组保留'));
  await mkdir(join(root, 'assets', '空分组'));
  for (const path of ['目录素材.png', '预览素材.png', '待删分组/组内.png', '待删分组/子分组/嵌套.png', '待删分组保留/同名.png']) {
    await copyFile(source, join(root, 'assets', path));
  }
  await writeFile(join(root, 'assets', '待删分组', '说明.txt'), '分组内的其他文件');
  // 直接存储入口也必须拒绝根目录、路径越界、链接、失效会话与类型不匹配。
  for (const path of ['', '.', '..', '../pages', 'C:/Windows', '待删分组/..', '待删分组\\子分组', '/']) {
    await assert.rejects(store.deleteAsset(initial.id, path, 'directory'));
  }
  await assert.rejects(store.deleteAsset('过期会话', '空分组', 'directory'));
  await assert.rejects(store.deleteAsset(initial.id, '目录素材.png', 'directory'));
  await assert.rejects(store.deleteAsset(initial.id, '待删分组', 'image'));
  await assert.rejects(store.deleteAsset(initial.id, '目录素材.png', 'invalid' as AssetEntry['kind']));
  const linked = join(root, 'assets', '含链接分组');
  await mkdir(linked);
  await symlink(temporary, join(linked, '外部链接'), 'junction');
  await assert.rejects(store.deleteAsset(initial.id, '含链接分组', 'directory'), /链接/u);
  await assert.rejects(store.deleteAsset(initial.id, '含链接分组/外部链接', 'directory'), /链接/u);
  assert.deepEqual(await readFile(source), bytes);

  const opened = await controller.loadSmokeAlbum(root);
  const state = (): Promise<AlbumState> => window.webContents.executeJavaScript('window.desktop.getAlbumState()');
  const call = (expression: string): Promise<AlbumResult<null>> => window.webContents.executeJavaScript(expression);
  assert.equal((await call(`window.desktop.createPage(${JSON.stringify(opened.id)}, '保留画布', 'portrait')`)).status, 'success');
  let current = await state();
  const albumId = opened.id;
  const pageId = current.canvas!.pageId;
  for (const path of ['目录素材.png', '待删分组/子分组/嵌套.png']) {
    assert.equal((await call(`window.desktop.addPageImage(${JSON.stringify(albumId)}, ${JSON.stringify(pageId)}, ${JSON.stringify(path)})`)).status, 'success');
  }
  current = await state();
  const image = current.canvas!.document.objects[0]!;
  assert.equal((await call(`window.desktop.movePageObject(${JSON.stringify(albumId)}, ${JSON.stringify(pageId)}, ${JSON.stringify(image.id)}, 12, 24)`)).status, 'success');
  const draft = (await state()).canvas;
  const canvasPath = join(root, 'pages', '001', 'canvas.json');
  const savedCanvas = await readFile(canvasPath, 'utf8');
  const savedManifest = await readFile(join(root, 'project.json'), 'utf8');
  const pageImages = draft!.document.objects.map(object => {
    assert.equal(object.kind, 'image');
    return join(root, 'pages', '001', object.kind === 'image' ? object.fileName : '');
  });
  assert.equal(draft?.dirty, true);
  const lease = randomUUID();
  const preview = await window.webContents.executeJavaScript(`window.desktop.requestAssetImage(${JSON.stringify(albumId)}, '待删分组/子分组/嵌套.png', 'preview', ${JSON.stringify(lease)})`);
  assert.equal(preview.status, 'success');
  assert.equal((await net.fetch(preview.value)).status, 200);

  const originalMessage = dialog.showMessageBox;
  const originalTrash = shell.trashItem;
  const prompts: MessageBoxOptions[] = [];
  dialog.showMessageBox = (async (...args: unknown[]) => {
    const options = args[1] as MessageBoxOptions;
    prompts.push(options);
    return { response: 0, checkboxChecked: false };
  }) as typeof dialog.showMessageBox;
  try {
    await waitFor(window, "document.querySelector('[data-asset-directory=\"待删分组\"]')");
    await rightClick(window, '[data-asset-directory="待删分组"]');
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('[data-delete-asset]').textContent.trim()"), '删除分组');
    await capture(window, join(temporary, 'group-menu.png'));
    await window.webContents.executeJavaScript("document.querySelector('[data-delete-asset]').click()");
    await waitFor(window, "document.querySelector('[data-app-dialog=warning][open]')");
    const alert = await window.webContents.executeJavaScript(`(() => {
      const element = document.querySelector('[data-app-dialog=warning]');
      return { role: element.getAttribute('role'), text: element.textContent,
        focus: document.activeElement.hasAttribute('data-app-dialog-cancel') };
    })()`);
    assert.equal(alert.role, 'alertdialog');
    assert(alert.text.includes('全部子分组和文件'));
    assert(alert.text.includes('已有画布中的图片不受影响'));
    assert.equal(alert.focus, true);
    const requestId = (await window.webContents.executeJavaScript('window.desktop.getAppDialog()')).request.id;
    assert.equal(await window.webContents.executeJavaScript("window.desktop.respondAppDialog('过期请求', true)"), false);
    assert.equal(await window.webContents.executeJavaScript(`window.desktop.respondAppDialog(${JSON.stringify(requestId)}, '不是布尔值')`), false);
    assert.equal((await call('window.desktop.createAlbum()')).status, 'error');
    assert.equal(Menu.getApplicationMenu()!.getMenuItemById('about-app')!.enabled, false);
    await capture(window, join(temporary, 'group-warning-dialog.png'));
    await window.webContents.executeJavaScript("document.querySelector('[data-app-dialog-cancel]').click()");
    await waitFor(window, "document.querySelector('.status-message').textContent === '已取消删除素材'");
    assert((await lstat(join(root, 'assets', '待删分组'))).isDirectory());
    assert.equal(await window.webContents.executeJavaScript(`window.desktop.respondAppDialog(${JSON.stringify(requestId)}, true)`), false);
    assert.deepEqual((await state()).canvas, draft);

    // Esc 与渲染页重载都必须取消删除，不能把遗留响应应用到下一次操作。
    await rightClick(window, '[data-asset-directory="待删分组"]');
    await window.webContents.executeJavaScript("document.querySelector('[data-delete-asset]').click()");
    await waitFor(window, "document.querySelector('[data-app-dialog=warning][open]')");
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await waitFor(window, "!document.querySelector('[data-app-dialog]') && document.querySelector('.assets-panel').getAttribute('aria-busy') === 'false'");
    await rightClick(window, '[data-asset-directory="待删分组"]');
    await window.webContents.executeJavaScript("document.querySelector('[data-delete-asset]').click()");
    await waitFor(window, "document.querySelector('[data-app-dialog=warning][open]')");
    window.webContents.reload();
    await waitFor(window, "document.querySelector('[data-app-ready]') && !document.querySelector('[data-app-dialog]') && document.querySelector('.assets-panel').getAttribute('aria-busy') === 'false'");
    assert((await lstat(join(root, 'assets', '待删分组'))).isDirectory());
    assert.deepEqual((await state()).canvas, draft);

    const aboutItem = Menu.getApplicationMenu()!.getMenuItemById('about-app')!;
    aboutItem.click(aboutItem, window, {} as Electron.KeyboardEvent);
    await waitFor(window, "document.querySelector('[data-app-dialog=about][open]')");
    const about = await window.webContents.executeJavaScript("document.querySelector('[data-app-dialog=about]').textContent");
    for (const text of ['画册工坊', 'V1.0', '刘伟', 'lw18751836671@163.com']) assert(about.includes(text));
    assert.equal((await state()).canvas?.dirty, true);
    await capture(window, join(temporary, 'about-dialog.png'));
    window.setSize(1000, 680);
    await waitFor(window, 'window.innerWidth <= 1000');
    assert(await window.webContents.executeJavaScript(`(() => {
      const bounds = document.querySelector('[data-app-dialog=about]').getBoundingClientRect();
      return bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight;
    })()`));
    await capture(window, join(temporary, 'about-dialog-compact.png'));
    await window.webContents.executeJavaScript("document.querySelector('.app-dialog-close').click()");
    await waitFor(window, "!document.querySelector('[data-app-dialog]')");
    window.setSize(1440, 960);

    await rightClick(window, '[data-asset-file="目录素材.png"]');
    await window.webContents.executeJavaScript("document.querySelector('[data-delete-asset]').click()");
    await confirmWarning(window);
    await waitFor(window, "!document.querySelector('[data-asset-file=\"目录素材.png\"]') && document.querySelector('.assets-panel').getAttribute('aria-busy') === 'false'");
    await assert.rejects(lstat(join(root, 'assets', '目录素材.png')), { code: 'ENOENT' });

    // 删除组前选择其子分组，成功后选择回退根目录，不能落在已删除的导入位置。
    await window.webContents.executeJavaScript("document.querySelector('[data-asset-directory=\"待删分组\"]').click()");
    await waitFor(window, "document.querySelector('[data-asset-directory=\"待删分组/子分组\"]')");
    await window.webContents.executeJavaScript("document.querySelector('[data-asset-directory=\"待删分组/子分组\"]').click()");
    await rightClick(window, '[data-asset-directory="待删分组"]');
    await window.webContents.executeJavaScript("document.querySelector('[data-delete-asset]').click()");
    await confirmWarning(window);
    await waitFor(window, "!document.querySelector('[data-asset-directory=\"待删分组\"]') && document.querySelector('[data-asset-root]').getAttribute('aria-pressed') === 'true'");
    await assert.rejects(lstat(join(root, 'assets', '待删分组')), { code: 'ENOENT' });
    assert.equal((await net.fetch(preview.value)).status, 404);
    assert.deepEqual(await readFile(join(root, 'assets', '待删分组保留', '同名.png')), bytes);

    await window.webContents.executeJavaScript("document.querySelector('#asset-tab-gallery').click()");
    await waitFor(window, "document.querySelector('[data-thumbnail-card=\"预览素材.png\"] img')");
    // 系统回收站失败必须保留源文件、草稿和可继续浏览的缩略图。
    shell.trashItem = async () => { throw Object.assign(new Error('模拟回收站失败'), { code: 'EPERM' }); };
    await rightClick(window, '[data-thumbnail-card="预览素材.png"]');
    const previousSource = await window.webContents.executeJavaScript("document.querySelector('[data-thumbnail-card=\"预览素材.png\"] img').src");
    await window.webContents.executeJavaScript("document.querySelector('[data-delete-asset]').click()");
    await confirmWarning(window);
    await waitFor(window, "document.querySelector('.status-message').textContent.startsWith('删除失败') && document.querySelector('.assets-panel').getAttribute('aria-busy') === 'false'");
    assert.deepEqual(await readFile(join(root, 'assets', '预览素材.png')), bytes);
    await waitFor(window, `document.querySelector('[data-thumbnail-card="预览素材.png"] img')?.naturalWidth > 0 && document.querySelector('[data-thumbnail-card="预览素材.png"] img')?.src !== ${JSON.stringify(previousSource)}`);
    shell.trashItem = originalTrash;
    await rightClick(window, '[data-thumbnail-card="预览素材.png"]');
    await capture(window, join(temporary, 'gallery-menu.png'));
    await window.webContents.executeJavaScript("document.querySelector('[data-delete-asset]').click()");
    await confirmWarning(window);
    await waitFor(window, "!document.querySelector('[data-thumbnail-card=\"预览素材.png\"]') && document.querySelector('.assets-panel').getAttribute('aria-busy') === 'false'");
    await assert.rejects(lstat(join(root, 'assets', '预览素材.png')), { code: 'ENOENT' });
    await window.webContents.executeJavaScript(`void (window.pendingDelete = window.desktop.deleteAsset(${JSON.stringify(albumId)}, '空分组', 'directory'))`);
    await confirmWarning(window);
    assert.equal((await call('window.pendingDelete')).status, 'success');
    await assert.rejects(lstat(join(root, 'assets', '空分组')), { code: 'ENOENT' });
    assert.deepEqual((await state()).canvas, draft);
    assert.equal(await readFile(canvasPath, 'utf8'), savedCanvas);
    assert.equal(await readFile(join(root, 'project.json'), 'utf8'), savedManifest);
    for (const file of pageImages) assert.deepEqual(await readFile(file), bytes);
    assert.deepEqual(await readFile(source), bytes);
    assert.equal((await call('window.desktop.savePage()')).status, 'success');
    await controller.loadSmokeAlbum(root);
    assert.equal((await state()).canvas?.document.objects.length, 2);
    assert.equal((await state()).canvas?.warnings.length, 0);
    await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await capture(window, join(temporary, 'retained-canvas.png'));
    assert(prompts.every(options => options.type !== 'warning' && options.type !== 'info'));
  } finally { dialog.showMessageBox = originalMessage; shell.trashItem = originalTrash; }
  await writeFile(join(temporary, 'report.json'), JSON.stringify({ passed: true, temporaryAlbum: root,
    directoryAndGalleryMenus: true, confirmationAndCancel: true, nestedAndEmptyGroups: true,
    pageCopiesAndDraftPreserved: true, originalPreserved: true, reopenPreservesImages: true,
    invalidPathsAndLinksRejected: true, leasesRevoked: true, trashFailurePreservesFiles: true,
    customWarningAndAbout: true, cancelFocusEscapeAndReload: true, staleResponsesRejected: true,
    manualAcceptance: false }, null, 2));
  console.log(`素材删除验收通过：${temporary}`);
}
