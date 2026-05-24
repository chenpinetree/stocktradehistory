# stocktradehistory

股票交易记录与分析系统（Web + 单容器 Docker 部署）。

## 技术栈

- 前端: React + Vite + Ant Design
- 后端: Node.js (`server/index.cjs`)
- 数据库: SQLite (`better-sqlite3`)

> 不使用 MariaDB/MySQL/PostgreSQL。数据以 SQLite 文件方式存储。

## 端口与数据目录

- 默认访问端口: `3737`
- 容器内数据目录: `/app/data`
- 默认数据库文件: `/app/data/trade-history.db`

## 本地开发

```bash
npm ci
npm run build
npm start
```

浏览器访问: `http://localhost:3737`

## Docker 一键部署（单容器）

```bash
docker compose up -d --build
```

浏览器访问: `http://localhost:3737`

停止服务:

```bash
docker compose down
```

## 镜像命名规范

```bash
chenpinetree/stocktradehistory:latest
```

构建镜像:

```bash
npm run docker:build
```

## 更新迭代流程

1. 本地更新代码并提交到 GitHub。
2. 在部署机拉取最新代码。
3. 执行：

```bash
docker compose up -d --build
```

这会重建并替换容器，实现软件更新。

## 备份与恢复

系统支持在页面中导出/导入 JSON 备份（交易、设置、AI 报告）。

## 当前数据迁移策略

- 当前阶段: **不自动迁移** 旧本机数据库到容器。
- 旧数据将继续保留在原本机位置。
- 需要迁移时，可后续手工将旧 `trade-history.db` 拷贝到容器数据卷对应目录。
