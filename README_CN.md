# T3 对话导入与管理工具 (t3-import)

将 **Codex** 和 **Claude Code** 的本地历史对话记录导入、同步并管理至 **T3 Code** 中。

---

## 🌟 核心特性

- **一键导入 Codex 历史记录**：支持自动发现 `~/.codex` 下的所有历史会话，包括提问、回答、思考链（Reasoning Summary）、工具调用（Tool Calls）、Token 消耗以及图片附件。
- **专为最新版 T3 Code 适配**：完美兼容 T3 最新 V2 架构（Migration 76+），自动定位 `~/.t3/userdata/statev2.sqlite`，导入后在 T3 侧边栏和搜索框瞬间可见。
- **全中文友好界面**：CLI 命令说明与交互式终端（TUI）全界面简体中文，支持快捷键多选、搜索、全选与预览。
- **数据安全保障**：每次真实写入前均会自动创建经过完整性验证的 SQLite 数据库快照备份，安全无忧。

---

## 🛠️ 快速上手

### 1. 运行交互式终端 (TUI)
直接在终端中运行：
```bash
t3-import
```
根据界面提示操作：
1. 选择来源（如 `Codex`）；
2. 选择工作区（Workspace）；
3. 用键盘上下移动，按 **空格** 勾选想导入的会话（或按 **a** 全选，按 **/** 关键字搜索）；
4. 按 **Enter** 确认并执行导入；
5. 完成后可选择直接启动 T3 Code 查看！

### 2. 常用命令行指令

* **健康体检（只读无侵入）**：
  ```bash
  t3-import doctor
  ```
* **查看 Codex 历史会话清单**：
  ```bash
  t3-import list --source codex
  ```
* **导入指定会话**：
  ```bash
  t3-import import --source codex --workspace "/path/to/project" --thread <会话ID> --yes
  ```
* **全量导入某个项目下的所有会话**：
  ```bash
  t3-import import --source codex --workspace "/path/to/project" --all --yes
  ```

---

## ⚠️ 注意事项
* **执行实际导入前，请先完全退出 T3 Code 桌面应用**（防止 SQLite 数据库被锁或缓存不同步）。
