export type SiteSection = {
  id: string;
  eyebrow?: string;
  title: string;
  body: string;
  kind: "story" | "menu" | "stores" | "quote";
  items?: { title: string; detail: string; meta?: string }[];
};

export type SiteSpec = {
  brand: string;
  title: string;
  subtitle: string;
  heroImage: string;
  theme: {
    primary: string;
    accent: string;
    background: string;
    surface: string;
    text: string;
  };
  sections: SiteSection[];
};

export const defaultSite: SiteSpec = {
  brand: "精品咖啡馆",
  title: "每一杯，都是时光的艺术",
  subtitle: "精选产地 · 匠心烘焙 · 预约专属座位",
  heroImage: "https://cdn.prod.website-files.com/66d17ac665656afb2f593dda/66d1b38988987b70d8f37021_bg2_tiny.jpg",
  theme: { primary: "#5a4639", accent: "#e58b52", background: "#f5f1e8", surface: "#fffdf8", text: "#2f241e" },
  sections: [
    { id: "story", eyebrow: "ABOUT THE HOUSE", title: "给忙碌生活留一张安静的桌子", body: "我们从一颗豆子开始，寻找适合城市日常的风味。每一家店都保留慢下来的空间，让一杯认真做的咖啡成为工作与生活之间的呼吸。", kind: "story" },
    { id: "menu", eyebrow: "TODAY'S PICKS", title: "本周值得点的三杯", body: "从明亮的花香到醇厚的可可尾韵，为你留下刚刚好的选择。", kind: "menu", items: [{ title: "桂花拿铁", detail: "柔和奶香与桂花的轻盈回甘", meta: "¥38" }, { title: "日晒耶加", detail: "柑橘、莓果与清爽的花香", meta: "¥42" }, { title: "海盐焦糖冷萃", detail: "低甜度、长尾韵，适合午后", meta: "¥36" }] },
    { id: "stores", eyebrow: "FIND YOUR CORNER", title: "在城市里，找到你的专属座位", body: "提前预约，抵达时咖啡和座位都已经为你准备好。", kind: "stores", items: [{ title: "安福路店", detail: "上海市徐汇区安福路 218 号", meta: "08:00—22:00" }, { title: "东山口店", detail: "广州市越秀区烟墩路 31 号", meta: "09:00—21:30" }] },
  ],
};

export type CopilotResult = { reply: string; changes: string[]; site: SiteSpec; mode: "model" };
