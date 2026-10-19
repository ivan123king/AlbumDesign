/** 文件用途：使用项目内 Electron 隐藏运行框架检查，超时结束并返回正确退出码。 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const electron = require('electron');
const root = fileURLToPath(new URL('../', import.meta.url));
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const smokeFlag = process.argv.includes('--layers') ? '--layer-smoke' : process.argv.includes('--text') ? '--text-smoke' : '--framework-smoke';
const child = spawn(electron, [root, smokeFlag], {
  cwd: root, env: environment, stdio: 'inherit', windowsHide: true
});
const timer = setTimeout(() => {
  console.error('Electron 验证超过 180 秒，已结束。');
  child.kill();
}, 180000);
child.on('error', error => { clearTimeout(timer); console.error(error); process.exitCode = 1; });
child.on('exit', code => { clearTimeout(timer); process.exitCode = code ?? 1; });
