# dsh-sql-formatter

> DeepSeek Harness SQL 格式化与优化

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## ✨ 功能特性

- ✨ **SQL 格式化**: 自动美化 SQL 语句
- 📊 **查询分析**: 分析查询性能和复杂度
- ⚡ **优化建议**: 检测 N+1 查询、缺失索引
- 🔍 **索引建议**: 根据 schema 建议索引

## 📦 安装

```bash
npm install dsh-sql-formatter
```

## 🛠️ 工具

| 工具名 | 描述 | 参数 |
|--------|------|------|
| `sql_format` | 格式化 SQL | `sql`, `indent` |
| `sql_analyze` | 分析查询 | `sql` |
| `sql_optimize` | 优化建议 | `sql` |
| `sql_indexes` | 索引建议 | `sql` |

## 📋 命令

- `/sql format <sql>` — 格式化
- `/sql analyze <sql>` — 分析
- `/sql optimize <sql>` — 优化

## ⚙️ 配置

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `enabled` | boolean | `true` | 启用插件 |
| `dialect` | string | `standard` | SQL 方言 |
| `indentSize` | number | `2` | 缩进大小 |

## 📄 License

MIT
