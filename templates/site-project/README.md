# AI Website Project Skeleton

这是 AI 建站 Agent 使用的 React + TypeScript + Vite 项目骨架。

## 目录约定

- `design/tokens.json`：设计令牌的机器可读版本
- `docs/prd.md`：需求分析 Skill 产出的产品需求文档
- `docs/design.md`：设计推导 Skill 产出的设计规范和页面内容蓝图
- `docs/site-plan.json`：供代码 Agent 和审查阶段读取的机器可读页面计划
- `skills/`：教 Agent 如何分析需求、推导设计和审查内容的项目内 Skill
- `src/styles/tokens.css`：运行时设计变量
- `src/layouts/SiteLayout.tsx`：所有页面共享的布局外壳
- `src/components/ui/`：基础 UI 组件
- `src/components/site/`：网站公共组件
- `src/pages/`：页面级组件
- `src/app/site-manifest.ts`：站点品牌和路由清单
- `AGENT.md`：Agent 修改代码时必须遵守的约束

## 开发

```sh
npm install
npm run dev
```

页面使用固定路由：`/`、`/menu`、`/stores`、`/reservation`、`/contact`。

根工程通过 `pnpm sync:template` 将这份模板嵌入 Agent 服务端，确保本地预览和部署环境使用相同的项目骨架。
