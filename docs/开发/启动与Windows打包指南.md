# 启动与 Windows 打包指南

本文用于从源码启动软件，以及打包后发给其他人使用。所有命令均在 **Windows PowerShell** 中执行。

## 1. 在哪个目录执行命令

在项目根目录执行，即包含 `package.json`、`package-lock.json`、`src` 和 `scripts` 的 `AlbumDesign` 目录，不能在 `docs` 或 `src` 中执行。

本机路径如下；其他人拿到源码后，替换成自己的项目路径：

```powershell
Set-Location 'E:\workspace\other_workspace\AlbumDesign'
```

后续每次新开 PowerShell，都先进入这个目录。

## 2. 首次准备开发与打包环境

开发、打包电脑需要 Windows 11 x64、Node.js 24.x 和随附的 npm。先检查版本：

```powershell
node -v
npm -v
```

项目要求 Node.js `>=24.0.0 <25`。在项目根目录安装固定版本依赖和 Electron 运行环境：

```powershell
$env:electron_config_cache = Join-Path $PWD '.cache/electron'
npm ci
node node_modules/electron/install.js --no
```

逐条执行，上一条成功后再继续。首次安装需要联网下载；`npm ci` 会重建 `node_modules`，通常只在首次准备环境或依赖锁文件变化后执行。构建工具不需要全局安装，也不需要安装 C++ 编译器。

如果 Electron 下载连接失败，可在当前 PowerShell 临时设置镜像后重试安装，保留官方包内置校验：

```powershell
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
node node_modules/electron/install.js --no
```

这些环境变量只影响当前 PowerShell 及其启动的进程。npm 缓存由项目 `.npmrc` 配置到 `.cache/npm`，Electron 缓存按上述命令放到 `.cache/electron`。

## 3. 从源码启动软件

日常开发，在项目根目录运行：

```powershell
npm run dev
```

命令会打开桌面窗口，前端修改支持热更新。保持终端开启；结束开发时关闭窗口并在终端按 `Ctrl+C`。开发服务器使用 `127.0.0.1:5173`，端口被占用时先结束此前的开发进程。

如需运行构建后的版本，在同一目录逐条执行：

```powershell
npm run build
npm start
```

`npm run build` 会先做 TypeScript 检查，再生成 `out`；`npm start` 运行最近一次构建，修改源码后需要重新构建。

## 4. 打包 Windows EXE 程序目录

先关闭正在运行的打包版软件，以免输出文件被占用。在项目根目录运行：

```powershell
npm run package
```

此命令会自动检查类型、构建最新源码，并打包 Windows x64 程序，不需要先单独运行 `npm run build`。打包会替换同名的旧程序输出目录；首次打包可能需要下载 Electron，也会优先复用工程缓存中的运行环境压缩包。

成功后，程序位于：

```text
E:\workspace\other_workspace\AlbumDesign\release\AlbumDesign-win32-x64\AlbumDesign.exe
```

在项目根目录可用下列命令启动成品检查：

```powershell
& '.\release\AlbumDesign-win32-x64\AlbumDesign.exe'
```

**当前输出是包含 EXE 和运行依赖的完整目录，不是单文件 EXE 安装器。不能只把 `AlbumDesign.exe` 发给别人，必须保留整个 `AlbumDesign-win32-x64` 目录。** 当前未提供安装器、自动更新或代码签名。

## 5. 制作可以发送的 ZIP 包

确认上一步打包成功后，仍在项目根目录运行：

```powershell
Compress-Archive -LiteralPath '.\release\AlbumDesign-win32-x64' -DestinationPath '.\release\AlbumDesign-win32-x64.zip' -Force
```

该命令将完整程序目录压缩为 ZIP，`-Force` 会覆盖同名旧 ZIP。每次修改代码后，都要重新执行 `npm run package`，成功后再执行压缩命令，避免发送旧版本。

发给别人的是这个文件：

```text
E:\workspace\other_workspace\AlbumDesign\release\AlbumDesign-win32-x64.zip
```

不要发送 `out`、`node_modules` 或 `.cache` 代替成品包。打包输入仅包含构建产物和包元数据，不包含本机画册、软件设置和最近画册记录；如需发送作品，另外复制完整画册目录。

## 6. 接收方如何使用

1. 使用 Windows 11 x64，将 ZIP 完整解压到本地目录。
2. 进入解压后的 `AlbumDesign-win32-x64`，双击 `AlbumDesign.exe`；不要直接在 ZIP 预览窗口中运行。
3. 运行依赖已随包提供，接收方不需要安装 Node.js、npm、Python 或开发工具。
4. 使用“新建画册”选择单独的空目录，或使用“打开画册”选择已有画册目录；建议将作品放在程序目录之外，方便后续替换软件。

## 7. 发送前检查

- 确认打包命令成功，ZIP 来自本次生成的完整程序目录。
- 把 ZIP 解压到另一处目录，启动其中的 EXE，使用临时画册检查新建、导入图片、添加画布和文字、保存后重开、导出 PDF；核对中文、页序及页面内容。
- 尽量在另一台未安装开发环境的 Windows 11 x64 电脑上重复检查。跨机器分发尚待实际验收，不能将本机打包成功视为已完成跨机器验证。

开发专项命令和已有验收记录见 [构建与运行](构建与运行.md)。
