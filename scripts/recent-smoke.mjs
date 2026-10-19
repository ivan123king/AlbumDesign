/** 文件用途：以四次独立 Electron 启动验证最近画册恢复，所有配置和画册仅放在临时验收目录。 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, '.cache', 'verification');
await mkdir(output, { recursive: true });
const run = basename(await mkdtemp(join(output, 'recent-')));
const electron = createRequire(import.meta.url)('electron');
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;

/** 每步等待进程真实退出再重新启动，共用本次专属配置，超时或失败立即停止后续步骤。 */
async function launch(step) {
  await new Promise((resolve, reject) => {
    const child = spawn(electron, [root, '--recent-smoke', `--recent-run=${run}`, `--recent-step=${step}`], {
      cwd: root, env: environment, stdio: 'inherit', windowsHide: true
    });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`最近画册验收 ${step} 超时。`)); }, 90000);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => {
      clearTimeout(timer);
      if (code === 0) resolve(); else reject(new Error(`最近画册验收 ${step} 失败，退出码 ${code}。`));
    });
  });
}

for (const step of ['seed', 'restored', 'disabled', 'missing']) await launch(step);
console.log(`最近画册跨进程验收通过：${join(output, run)}`);
