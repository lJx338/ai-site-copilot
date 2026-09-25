# AI Agent Contract

这个项目允许 Agent 直接修改真实 React/TypeScript 代码，但必须先理解需求和设计文档，再决定如何修改：

1. 新建网站时先读取 `skills/requirements/SKILL.md`、`skills/design-derivation/SKILL.md` 和 `skills/site-review/SKILL.md`，再读取 `docs/prd.md`、`docs/design.md`、`docs/site-plan.json`、`design/tokens.json`、`src/app/site-manifest.ts` 和相关页面。
2. `docs/prd.md` 负责说明用户、页面目的、内容和功能；`docs/design.md` 负责说明设计判断、页面内容蓝图、素材、文案和多端规则；`docs/site-plan.json` 提供机器可读的页面计划。代码必须以这三份文档为依据。
3. 全站公共结构只能通过 `src/layouts/SiteLayout.tsx`、`src/components/site/Header.tsx` 和 `src/components/site/Footer.tsx` 修改。
4. 颜色、字体、间距、圆角和阴影优先使用 `src/styles/tokens.css` 中的变量，禁止在页面里重新发明一套视觉变量。
5. 新增页面必须加入 `src/app/App.tsx` 和 `src/app/site-manifest.ts`，并复用已有的 `PageHero`、`Section`、`Container`、`ContentCard`、`Button`，同时保留页面自己的叙事和信息层级。
6. 页面内容不能用两句通用文案代替完整区块。按照设计文档的内容目标补足故事、产品、门店、流程、联系方式、图片方向和行动入口；可以自行选择更好的表达方式，并在总结中说明关键取舍。
7. 修改文案时只改对应页面或内容文件，不要重写公共布局。用户要求修改一个页面时，保留其他页面的内容和结构。
8. 每次修改后检查首页、修改页面和移动端布局，确认 Header、Footer、导航和按钮仍然一致。
9. 页面出现白屏、默认浏览器样式、横向溢出或资源加载失败时，先修复构建和资源问题，再继续视觉调整。
10. 网站必须像一个可以直接上线的真实网站：用户没有提供的事实（地址、电话、营业时间、价格、产品、人物、评价）由你补全成可信、具体、全站一致的示例内容，集中放在 `src/content/` 中复用，并把这些补全项列在 `docs/content-todo.md`。页面里禁止出现 `{占位}`、“待确认”“敬请期待”、example.com 等占位写法。
11. 导航和按钮里的每个内部链接都必须指向 `site-manifest.ts` 中已注册、已在 `App.tsx` 接入的路由；`src/content/` 里的数据文件必须被页面实际使用。
