---
name: site-blocks
description: 区块库目录。页面 Agent 优先组合这些精心设计的区块来搭页面，不合适时可以自己写；每个区块的用途、参数和适用场景。
---

# 区块库

从 `../components/blocks` 导入（页面文件在 `src/pages/` 下）：

```tsx
import { Hero, FeatureGrid, SplitFeature, ProductGrid, StatsBand, Testimonials, Steps, Faq, CtaBand } from "../components/blocks";
```

所有区块都已处理好手机端、间距、字号、进入视口动效和配色（跟随 tokens.css），图片参数会自动配图。**优先用区块搭页面**，把精力放在内容和区块的组合节奏上；区块表达不了的内容（复杂表格、交互筛选、特殊图表）再自己写，写的部分沿用 tokens.css 变量。不要修改区块库文件。

## 通用参数

- `image`：`{ slot, query, prompt?, kind?, alt, ratio?, focus? }`，和 SiteImage 相同。slot 全站唯一。
- `actions`：`[{ label, to?: "/contact", href?: "tel:...", variant?: "primary" | "secondary" | "link" }]`，站内链接用 `to`。
- `intro`：区块标题区 `{ eyebrow?, title?, description?, align?: "left" | "center", action? }`。
- `tone`：`"light" | "muted" | "dark"`。**相邻区块交替使用 light 和 muted，每页用一两次 dark 制造节奏**，不要整页同一种背景。

## 区块目录

| 区块 | 用途 | 变体 |
|---|---|---|
| `Hero` | 页面首屏：标题、说明、按钮、主图、关键数字 | `split` 左文右图（默认）、`overlay` 满屏大图加蒙版（适合首页和氛围强的行业）、`centered` 居中文字加下方宽图 |
| `LogoCloud` | 客户或合作伙伴名称条，放在首屏后做信任背书 | — |
| `StatsBand` | 一排关键数字（3–4 个），默认深色，打断页面节奏 | — |
| `FeatureGrid` | 卖点、服务、优势 | `cards` 带图卡片、`icons` 图标加文字（图标用 lucide-react）、`bento` 首项大格突出核心卖点 |
| `SplitFeature` | 图文左右交错讲 2–4 个重点（方案、工艺、流程、空间） | `startImageLeft` 控制起始方向 |
| `ProductGrid` | 产品或服务卡（带图、规格、价格、角标） | `card` 大卡（3–6 个）、`compact` 横向小卡（6 个以上的完整列表） |
| `Gallery` | 空间、作品、案例图片 | `mosaic` 首图放大拼贴（放 3 张或 5 张最整齐）、`grid` 等大网格（3 的倍数） |
| `Testimonials` | 客户评价（3 条或 3 的倍数） | `grid` 三列、`featured` 左侧大字首条加右侧其余几条 |
| `Steps` | 服务流程、购买步骤、品牌历程 | `steps` 编号步骤、`timeline` 纵向时间轴（`meta` 填年份） |
| `Pricing` | 套餐或价格方案，`highlight` 推荐方案 | — |
| `Faq` | 常见问题（4–8 条） | — |
| `CtaBand` | 页尾行动号召，给 `image` 时是带背景图的深色横幅 | — |
| `ContactBlock` | 联系方式加留言表单（字段可配置，浏览器内校验和成功状态） | — |

## 示例

```tsx
<Hero
  variant="split"
  eyebrow="HENGZHUN INSTRUMENTS"
  title="精密测量，可追溯到每一台仪器"
  description="16 个在售型号覆盖示波器、直流电源与数据采集，7 款现货 3 日内发。"
  actions={[{ label: "获取选型报价", to: "/contact" }, { label: "查看全部型号", to: "/products", variant: "secondary" }]}
  image={{ slot: "home-hero", kind: "photo", query: "engineer oscilloscope electronics lab", prompt: "实验室里工程师用示波器调试电路板", alt: "工程师在实验室调试电路" }}
  stats={[{ value: "16", label: "在售型号" }, { value: "3 日", label: "现货发货" }]}
/>
<ProductGrid
  intro={{ eyebrow: "PRODUCTS", title: "四条产品线", action: { label: "查看全部", to: "/products" } }}
  items={products.map((p) => ({ name: p.name, tagline: p.summary, price: p.price, badge: p.stock, specs: p.specs, to: "/products", image: { slot: `home-product-${p.id}`, kind: "product", query: p.imageQuery, prompt: p.imagePrompt, alt: p.name } }))}
/>
<SplitFeature tone="muted" items={[...]} />
<StatsBand items={[{ value: "22,000 m²", label: "自有厂房" }, ...]} />
<CtaBand title="告诉我们你的测试需求" actions={[{ label: "预约演示", to: "/contact" }]} image={{ slot: "home-cta", query: "modern electronics laboratory", alt: "实验室" }} />
```

## 版式节奏

- 一页通常 5–8 个区块：首屏 → 信任或数据 → 核心内容（2–3 个不同区块）→ 评价或流程 → FAQ → CTA。
- 同一种区块不要连续出现两次；卡片网格之间插入图文交错、数据带或画廊。
- 同类卡片超过 9 个时，用 `ProductGrid variant="compact"`、分组标题或筛选，避免整页长卡片堆叠。
- 每页至少 3 张图。
