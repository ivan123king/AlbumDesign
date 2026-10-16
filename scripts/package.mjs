/** 文件用途：只复制构建产物进行 Windows 目录打包，不把源码、文档和缓存带入成品。 */
import { packager } from '@electron/packager';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const staging = join(root, '.cache', 'package-input');
// 清理目标只允许是本工程缓存下的固定暂存目录，避免旧的哈希资源进入新包。
if (dirname(staging) !== join(root, '.cache')) throw new Error('打包暂存目录不在工程缓存内。');
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
await cp(join(root, 'out'), join(staging, 'out'), { recursive: true });
await writeFile(join(staging, 'package.json'), JSON.stringify({
  name: metadata.name, version: metadata.version, main: metadata.main,
  description: metadata.description, author: metadata.author
}, null, 2));
// 优先复用已校验的本地 Electron 压缩包，避免打包时重复下载运行环境。
const cache = join(root, '.cache', 'electron');
const cachedFiles = await readdir(cache, { recursive: true }).catch(() => []);
const zipName = `electron-v${metadata.devDependencies.electron}-win32-x64.zip`;
const cachedZip = cachedFiles.find(file => basename(file) === zipName);
const output = await packager({
  dir: staging, out: join(root, 'release'), name: 'AlbumDesign',
  platform: 'win32', arch: 'x64', electronVersion: metadata.devDependencies.electron,
  overwrite: true, download: { cacheRoot: cache },
  ...(cachedZip ? { electronZipDir: dirname(join(cache, cachedZip)) } : {})
});
console.log('打包完成：' + output.join(', '));
