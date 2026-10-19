/** 文件用途：使用项目内 Electron 隐藏运行框架检查，超时结束并返回正确退出码。 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const electron = require('electron');
const root = fileURLToPath(new URL('../', import.meta.url));
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const smokeFlag = process.argv.includes('--pdf') ? '--pdf-smoke' : process.argv.includes('--asset-delete') ? '--asset-delete-smoke' : process.argv.some(value => value === '--assets' || value === '--assets-ui') ? '--asset-preview-smoke' : process.argv.includes('--layers') ? '--layer-smoke' : process.argv.includes('--text') ? '--text-smoke' : '--framework-smoke';
const child = spawn(electron, [root, smokeFlag, ...(process.argv.includes('--assets-ui') ? ['--asset-preview-ui-only'] : [])], {
  cwd: root, env: environment, stdio: 'inherit', windowsHide: true
});
// 全库首次生成需要逐张解码，素材专项放宽总时限，其余回归保留原时限。
const timeoutSeconds = process.argv.includes('--assets') ? 600 : 180;
const timer = setTimeout(() => {
  console.error(`Electron 验证超过 ${timeoutSeconds} 秒，已结束。`);
  child.kill();
}, timeoutSeconds * 1000);
child.on('error', error => { clearTimeout(timer); console.error(error); process.exitCode = 1; });
child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
