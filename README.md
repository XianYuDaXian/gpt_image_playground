# GPT Image Playground

基于 OpenAI 图像接口的图片生成与编辑工具，当前版本已经重构为**前后端一体**架构：

- 前端只负责界面与编辑交互
- 后端统一保存 `API URL / API Key / model / timeout`
- 任务由后端发起、排队、落盘和回看
- 输入图、遮罩图、输出图都会先保存到后端本地，再由前端显示
- 不再依赖 WebDAV

本仓库为 **[@XianYuDaXian](https://github.com/XianYuDaXian/gpt_image_playground)** 的 fork，原项目来自 **[@CookSleep](https://github.com/CookSleep/gpt_image_playground)**。

---

## 功能概览

- 文本生图
- 多参考图编辑
- 遮罩编辑
- Images API / Responses API 切换
- 历史任务回看
- 后端统一实时进度
- 后端保存运行配置
- 后端导出 / 导入备份
- Docker 单容器部署
- 移动端与 PWA 适配

---

## 当前架构

### 前端

- React 19
- TypeScript
- Vite
- Tailwind CSS
- Zustand
- Fabric.js

### 后端

- Fastify
- SQLite
- 本地磁盘媒体存储
- SSE 任务事件流

### 数据落点

- 运行配置：SQLite
- 任务记录：SQLite
- 输入图 / 遮罩图 / 输出图 / 缩略图：后端本地目录

---

## Docker 部署

当前 Docker 方案是**单容器**生产部署：

- Fastify 同时提供前端静态页面
- `/api` 后端接口
- `/media` 媒体文件

### 快速启动

```bash
cd deploy
cp .env.example .env
docker compose up -d --build
```

启动后访问：

- [http://localhost:8787/](http://localhost:8787/)
- [http://localhost:8787/health](http://localhost:8787/health)

### 关键环境变量

见 [deploy/.env.example](/C:/Users/xianyu/Desktop/gpt_image_playground/deploy/.env.example)。

常用项：

- `APP_PORT`
- `APP_HOST`
- `APP_SECRET`
- `UPSTREAM_API_URL`
- `UPSTREAM_API_KEY`
- `UPSTREAM_MODEL`
- `UPSTREAM_API_MODE`
- `UPSTREAM_TIMEOUT_SECONDS`
- `UPSTREAM_CODEX_CLI`

### Docker 数据保存位置

`docker-compose.yml` 默认把容器内 `/app/data` 挂到宿主机：

- `./docker-data`

其中包含：

- `app.db`
- `media/uploads`
- `media/masks`
- `media/outputs`
- `media/thumbs`

也就是说，**容器删掉后数据仍保留在宿主机**。

---

## 本地开发

### 安装依赖

```bash
npm install
npm --prefix server install
```

### 启动前后端开发服务

前端：

```bash
npm run dev -- --host 0.0.0.0
```

后端：

```bash
npm run dev:server
```

默认地址：

- 前端：[http://localhost:5173/](http://localhost:5173/)
- 后端：[http://localhost:8787/health](http://localhost:8787/health)

### 本地构建

前端：

```bash
npm run build
```

后端：

```bash
npm run build:server
```

---

## 运行配置

程序启动后可以通过前端设置页配置：

- API URL
- API Key
- API 接口模式
- 模型 ID
- 请求超时
- Codex CLI 模式

这些配置会保存到后端，而不是浏览器本地。

同时也支持通过环境变量在服务启动时注入默认值。

---

## 备份与清理

设置页支持：

- 打包保存到本地
- 导入本地备份
- 清空远端记录
- 清空远端全部
- 清空本地缓存

其中“远端”指后端 SQLite 与后端媒体目录。

---

## 技术说明

- 前端不再直接向上游图片接口发请求
- 前端显示结果图时优先走后端 `/media/...`
- 编辑器需要本地可编辑数据时，会把后端图片转存到浏览器缓存
- 任务完成或失败后都保留在后端，可随时回看

---

## 许可证

[MIT License](LICENSE)

## 致谢

- 原项目：[CookSleep/gpt_image_playground](https://github.com/CookSleep/gpt_image_playground)
- Fork 维护：[XianYuDaXian/gpt_image_playground](https://github.com/XianYuDaXian/gpt_image_playground)
