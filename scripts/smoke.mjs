/** 文件用途：使用项目内 Electron 隐藏运行框架检查，超时结束并返回正确退出码。 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const electron = require('electron');
const root = fileURLToPath(new URL('../', import.meta.url));
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const cropDevelopment = process.argv.includes('--crop-dev');
let developmentServer;
// 独立随机端口启动真实开发版 React，覆盖 StrictMode effect 重放；不占用用户的开发服务器。
if (cropDevelopment) {
  const [{ createServer }, { default: react }] = await Promise.all([import('vite'), import('@vitejs/plugin-react')]);
  developmentServer = await createServer({ root: fileURLToPath(new URL('../src/renderer/', import.meta.url)),
    plugins: [react(), { name: 'crop-development-csp',
      transformIndexHtml: html => html.replace("script-src 'self';", "script-src 'self' 'unsafe-inline';") }],
    server: { host: '127.0.0.1', port: 0, strictPort: true } });
  await developmentServer.listen();
  const address = developmentServer.httpServer.address();
  environment.ELECTRON_RENDERER_URL = `http://127.0.0.1:${address.port}`;
}
const smokeFlag = process.argv.includes('--crop') || cropDevelopment ? '--crop-smoke' : process.argv.includes('--pdf') ? '--pdf-smoke' : process.argv.includes('--asset-delete') ? '--asset-delete-smoke' : process.argv.some(value => value === '--assets' || value === '--assets-ui') ? '--asset-preview-smoke' : process.argv.includes('--layers') ? '--layer-smoke' : process.argv.includes('--text') ? '--text-smoke' : '--framework-smoke';
const child = spawn(electron, [root, smokeFlag, ...(process.argv.includes('--assets-ui') ? ['--asset-preview-ui-only'] : [])], {
  cwd: root, env: environment, stdio: 'inherit', windowsHide: true
});
// 全库首次生成需要逐张解码，素材专项放宽总时限，其余回归保留原时限。
const timeoutSeconds = process.argv.includes('--assets') ? 600 : 180;
const timer = setTimeout(() => {
  console.error(`Electron 验证超过 ${timeoutSeconds} 秒，已结束。`);
  child.kill();
}, timeoutSeconds * 1000);
child.on('error', error => { clearTimeout(timer); void developmentServer?.close(); console.error(error); process.exitCode = 1; });
child.on('exit', code => { clearTimeout(timer); void developmentServer?.close(); process.exitCode = code ?? 1; });
