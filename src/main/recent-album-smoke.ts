/** 文件用途：在独立临时配置中验证软件数据异常、真实 IPC 和多次启动的画册恢复。 */
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dialog, Menu } from 'electron';
import type { BrowserWindow } from 'electron';
import { AppDataStore } from './app-data';
import { AlbumStore } from './album-store';
import type { AlbumController } from './album-ipc';
import type { AlbumResult, AlbumState } from '../shared/album';

/** 等待真实 React 状态或布局完成，超时返回可定位的表达式。 */
async function waitFor(window: BrowserWindow, expression: string): Promise<void> {
  await window.webContents.executeJavaScript(`(async () => {
    for (let i = 0; !(${expression}); i++) {
      if (i > 200) throw new Error('最近画册界面等待超时：' + ${JSON.stringify(expression)});
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  })()`);
}

/** 真实磁盘异常验收；所有损坏、保护与外部修改只操作本次专属临时文件。 */
async function verifyDataFiles(output: string, album: string): Promise<void> {
  const directory = join(output, '配置异常');
  await mkdir(directory);
  const settingsPath = join(directory, 'settings.json');
  const statePath = join(directory, 'state.json');
  await writeFile(settingsPath, JSON.stringify({ formatVersion: 1, reopenLastAlbum: false, futureOption: '保留' }));
  await writeFile(statePath, '{ 损坏状态');
  const recovered = new AppDataStore(directory);
  await recovered.load();
  assert.equal(recovered.reopenLastAlbum, false);
  assert.equal(recovered.lastAlbum, null);
  assert(recovered.warnings.some(message => message.includes('损坏')));
  const backup = (await readdir(directory)).find(name => name.startsWith('state.corrupt-'))!;
  assert.equal(await readFile(join(directory, backup), 'utf8'), '{ 损坏状态');
  await recovered.rememberAlbum(album, '临时画册');
  await recovered.setReopenLastAlbum(true);
  assert.equal(JSON.parse(await readFile(settingsPath, 'utf8')).futureOption, '保留');
  const reread = new AppDataStore(directory);
  await reread.load();
  assert.equal(reread.reopenLastAlbum, true);
  assert.equal(reread.lastAlbum?.directory, album);

  const future = JSON.stringify({ formatVersion: 99, keep: '较新数据' });
  await writeFile(settingsPath, future);
  await writeFile(statePath, future);
  const newer = new AppDataStore(directory);
  await newer.load();
  await assert.rejects(newer.rememberAlbum(album, '拒绝覆盖'), /受保护/u);
  await assert.rejects(newer.setReopenLastAlbum(false), /受保护/u);
  assert.equal(await readFile(settingsPath, 'utf8'), future);
  assert.equal(await readFile(statePath, 'utf8'), future);

  await writeFile(settingsPath, JSON.stringify({ formatVersion: 1, reopenLastAlbum: true }));
  const externallyChanged = new AppDataStore(directory);
  await externallyChanged.load();
  await writeFile(settingsPath, JSON.stringify({ formatVersion: 1, reopenLastAlbum: false }));
  await assert.rejects(externallyChanged.setReopenLastAlbum(false), /外部修改/u);
  assert.equal(externallyChanged.reopenLastAlbum, true);
  assert.equal(JSON.parse(await readFile(settingsPath, 'utf8')).reopenLastAlbum, false);

  const collisionDirectory = join(output, '首次写入冲突');
  const collision = new AppDataStore(collisionDirectory);
  await collision.load();
  await writeFile(join(collisionDirectory, 'state.json'), future);
  await assert.rejects(collision.rememberAlbum(album, '拒绝首次覆盖'), { code: 'EEXIST' });
  assert.equal(await readFile(join(collisionDirectory, 'state.json'), 'utf8'), future);
  assert(!(await readdir(collisionDirectory)).some(name => name.endsWith('.tmp')));

  const blockedDirectory = join(output, '不可用数据目录');
  await writeFile(blockedDirectory, '模拟目录不可写');
  const unavailable = new AppDataStore(blockedDirectory);
  await unavailable.load();
  assert(unavailable.warnings.length > 0);
  await assert.rejects(unavailable.rememberAlbum(album, '失败保留默认'), /受保护/u);
}

/** 四次独立进程共用本次配置：新建记录、启动恢复、禁用恢复、路径失效后重试。 */
export async function runRecentAlbumSmoke(
  window: BrowserWindow, output: string, controller: AlbumController, appData: AppDataStore
): Promise<void> {
  const step = process.argv.find(value => value.startsWith('--recent-step='))?.slice('--recent-step='.length);
  const albumPath = join(output, '中文临时画册');
  const statePath = join(appData.directory, 'state.json');
  const state = (): Promise<AlbumState> => window.webContents.executeJavaScript('window.desktop.getAlbumState()');
  await waitFor(window, "document.querySelector('[data-app-ready]')");
  assert.equal((await state()).busy, false);

  if (step === 'seed') {
    assert.equal((await state()).album, null);
    assert.equal(Boolean(appData.lastAlbum), false);
    await mkdir(albumPath);
    await verifyDataFiles(output, albumPath);
    const picker = dialog.showOpenDialog;
    const messageBox = dialog.showMessageBox;
    let chosen = albumPath;
    let canceled = false;
    const messages: string[] = [];
    dialog.showOpenDialog = (async () => ({ canceled, filePaths: [chosen] })) as typeof dialog.showOpenDialog;
    dialog.showMessageBox = (async (...args: unknown[]) => {
      messages.push((args[1] as { message: string }).message);
      return { response: 0, checkboxChecked: false };
    }) as typeof dialog.showMessageBox;
    try {
      assert.equal((await window.webContents.executeJavaScript('window.desktop.createAlbum()')).status, 'success');
      let current = await state();
      assert.equal(appData.lastAlbum?.directory, albumPath);
      assert.equal((await window.webContents.executeJavaScript(`window.desktop.createPage(${JSON.stringify(current.album!.id)}, '恢复第一页', 'portrait')`)).status, 'success');
      await writeFile(join(output, 'manifest-before.json'), await readFile(join(albumPath, 'project.json')));
      const saved = await readFile(statePath, 'utf8');
      canceled = true;
      assert.equal((await window.webContents.executeJavaScript('window.desktop.openAlbum()')).status, 'canceled');
      assert.equal(await readFile(statePath, 'utf8'), saved);
      canceled = false; chosen = join(output, '不存在画册');
      assert.equal((await window.webContents.executeJavaScript('window.desktop.openAlbum()')).status, 'error');
      assert.equal(await readFile(statePath, 'utf8'), saved);
      assert.equal((await state()).album?.id, current.album?.id);
      // 清单有效但第一页损坏时，候选会话与最近记录也不得替换。
      const damagedAlbum = join(output, '坏页画册');
      await mkdir(damagedAlbum);
      await new AlbumStore().create(damagedAlbum);
      const manifest = JSON.parse(await readFile(join(damagedAlbum, 'project.json'), 'utf8'));
      manifest.nextPageNumber = 2;
      manifest.pages = [{ id: 'missing-page', name: '缺失画布', directoryName: '001' }];
      await writeFile(join(damagedAlbum, 'project.json'), JSON.stringify(manifest));
      chosen = damagedAlbum;
      assert.equal((await window.webContents.executeJavaScript('window.desktop.openAlbum()')).status, 'error');
      assert.equal(await readFile(statePath, 'utf8'), saved);
      assert.equal((await state()).album?.id, current.album?.id);
      assert.equal(messages.length, 2);
      // 真实目录被文件占用时，画册仍成功打开，提示持久化失败而非报画册打开失败。
      const held = join(output, '暂存配置');
      await rename(appData.directory, held);
      await writeFile(appData.directory, '模拟写入失败');
      try {
        chosen = albumPath;
        assert.equal((await window.webContents.executeJavaScript('window.desktop.openAlbum()')).status, 'success');
        current = await state();
        assert.equal(current.album?.name, '中文临时画册');
        assert(current.notice?.includes('未能记住'));
        assert.equal((await controller.setReopenLastAlbum(false)).status, 'error');
        assert.equal(appData.reopenLastAlbum, true);
        assert.equal(Menu.getApplicationMenu()?.getMenuItemById('reopen-last-album')?.checked, true);
        assert.equal(await readFile(join(held, 'state.json'), 'utf8'), saved);
        assert.equal(messages.length, 2);
      } finally { await unlink(appData.directory); await rename(held, appData.directory); }
      assert.equal((await window.webContents.executeJavaScript('window.desktop.openAlbum()')).status, 'success');
      assert.equal((await state()).notice, null);
    } finally { dialog.showOpenDialog = picker; dialog.showMessageBox = messageBox; }
  } else if (step === 'restored') {
    const restored = await state();
    assert.equal(restored.album?.name, '中文临时画册');
    assert.equal(restored.canvas?.pageId, restored.album.pages[0]?.id);
    assert.equal(restored.canvas?.dirty, false);
    await waitFor(window, "document.querySelector('.status-message')?.textContent === '画册已打开。'");
    assert.equal(await readFile(join(albumPath, 'project.json'), 'utf8'), await readFile(join(output, 'manifest-before.json'), 'utf8'));
    // 页面重载重新查询状态，不能重复触发自动打开或替换会话。
    await window.webContents.reload();
    await waitFor(window, "document.querySelector('[data-app-ready]')");
    assert.equal((await state()).album?.id, restored.album?.id);
    const item = Menu.getApplicationMenu()!.getMenuItemById('reopen-last-album')!;
    item.click(item, window, {} as Electron.KeyboardEvent);
    await window.webContents.executeJavaScript(`(async () => {
      for (let i = 0; (await window.desktop.getAlbumState()).busy; i++) {
        if (i > 200) throw new Error('设置保存等待超时');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    })()`);
    assert.equal(appData.reopenLastAlbum, false);
    assert.equal(JSON.parse(await readFile(join(appData.directory, 'settings.json'), 'utf8')).reopenLastAlbum, false);
  } else if (step === 'disabled') {
    assert.equal((await state()).album, null);
    assert.equal(appData.reopenLastAlbum, false);
    assert.equal(appData.lastAlbum?.directory, albumPath);
    assert.equal((await controller.setReopenLastAlbum(true)).status, 'success');
    assert.equal((await state()).album, null);
    await rename(albumPath, join(output, '暂时移走的画册'));
  } else if (step === 'missing') {
    const failed = await state();
    assert.equal(failed.album, null);
    assert(failed.notice?.includes('无法自动打开'));
    assert.equal(failed.canRetryLastAlbum, true);
    assert.equal(appData.lastAlbum?.directory, albumPath);
    await waitFor(window, "document.querySelector('[data-app-notice]') && !document.querySelector('[data-retry-last-album]').disabled");
    window.setSize(1000, 680);
    await waitFor(window, 'window.innerWidth <= 1000');
    assert(await window.webContents.executeJavaScript('document.documentElement.scrollWidth <= window.innerWidth'));
    await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await writeFile(join(output, 'missing-album.png'), (await window.webContents.capturePage()).toPNG());
    const saved = await readFile(statePath, 'utf8');
    const retry: AlbumResult<null> = await window.webContents.executeJavaScript('window.desktop.retryLastAlbum()');
    assert.equal(retry.status, 'error');
    assert.equal(await readFile(statePath, 'utf8'), saved);
    await rename(join(output, '暂时移走的画册'), albumPath);
    await window.webContents.executeJavaScript("document.querySelector('[data-retry-last-album]').click()");
    await waitFor(window, "!document.querySelector('[data-app-notice]') && document.querySelector('[data-paper]')");
    assert.equal((await state()).album?.name, '中文临时画册');
    assert.equal((await state()).canRetryLastAlbum, false);
    await writeFile(join(output, 'restored-album.png'), (await window.webContents.capturePage()).toPNG());
  } else throw new Error('未知最近画册验收步骤。');
  await writeFile(join(output, `${step}-report.json`), JSON.stringify({ step, passed: true,
    softwareDataDirectory: appData.directory, state: await state(), manualAcceptance: false }, null, 2));
  console.log(`最近画册验收通过：${step}`);
}
