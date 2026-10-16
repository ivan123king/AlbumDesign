/** 文件用途：分别构建 Electron 主进程、沙箱 preload 和 React 界面。 */
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    build: { rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.cjs' } } }
  },
  preload: {
    build: { rollupOptions: { output: { format: 'cjs', entryFileNames: 'index.cjs' } } }
  },
  renderer: {
    plugins: [react(), {
      name: 'local-development-csp',
      apply: 'serve',
      /** React 热更新需要内联引导脚本，仅本机开发服务器允许，构建版保持严格策略。 */
      transformIndexHtml(html) {
        return html.replace("script-src 'self';", "script-src 'self' 'unsafe-inline';");
      }
    }],
    server: { host: '127.0.0.1', port: 5173, strictPort: true }
  }
});
