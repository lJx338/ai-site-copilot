import type { SiteImageKind, SiteImageRatio } from "../ui/SiteImage";

/** 区块里的图片：只声明需要什么图，系统会自动从图库或 AI 配好 */
export type BlockImage = {
  slot: string;
  query: string;
  prompt?: string;
  kind?: SiteImageKind;
  alt: string;
  ratio?: SiteImageRatio;
  focus?: string;
};

/** 按钮或链接。to 是站内路由（如 "/contact"），href 用于电话、邮件和外链 */
export type BlockAction = { label: string; to?: string; href?: string; variant?: "primary" | "secondary" | "link" };

/** light：浅色背景；muted：浅灰背景，用来和相邻区块区分；dark：深色背景 */
export type BlockTone = "light" | "muted" | "dark";

export type SectionIntro = { eyebrow?: string; title?: string; description?: string; align?: "left" | "center"; action?: BlockAction };
