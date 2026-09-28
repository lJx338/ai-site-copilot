import { images } from "../../content/images";
import "../../styles/site-image.css";

export type SiteImageKind = "photo" | "product" | "portrait" | "texture" | "logo";
export type SiteImageRatio = "21:9" | "16:9" | "3:2" | "4:3" | "1:1" | "3:4" | "2:3" | "3:1" | "fill";

type SiteImageProps = {
  /** 全站唯一的图片位 ID，例如 "home-hero"、"products-ds5080" */
  slot: string;
  /** photo：真实场景照片；product：具体产品（由 AI 按 prompt 生成）；portrait：人物；texture：背景纹理；logo：客户或合作伙伴标志（完整显示、不裁切） */
  kind?: SiteImageKind;
  /** 使用用户上传资料里的图片，填资料卡图片清单里的 ID（如 "m12"）。有 asset 时不再搜图库或生成 */
  asset?: string;
  /** 给图库搜索的英文关键词，3–6 个词描述画面 */
  query: string;
  /** 给 AI 生成的中文画面描述（产品图、图库找不到时使用） */
  prompt?: string;
  /** 宽高比；"fill" 表示铺满父元素（父元素需要有高度） */
  ratio?: SiteImageRatio;
  alt: string;
  className?: string;
  /** 首屏图片设为 true，立即加载 */
  priority?: boolean;
  /** 裁切焦点，对应 CSS object-position，例如 "center top" */
  focus?: string;
};

// Agent 只声明需要什么图；系统在构建后读取页面上的 data-image-* 属性，
// 从图库搜索或用 AI 生成，写入 src/content/images.ts。
export default function SiteImage({ slot, kind = "photo", asset, query, prompt, ratio = "16:9", alt, className = "", priority = false, focus }: SiteImageProps) {
  const image = images[slot];
  const [w, h] = ratio === "fill" ? [0, 0] : ratio.split(":").map(Number);
  return (
    <figure
      className={`site-image${ratio === "fill" ? " site-image--fill" : ""}${className ? ` ${className}` : ""}`}
      style={ratio === "fill" ? undefined : { aspectRatio: `${w} / ${h}` }}
      data-image-slot={slot}
      data-image-kind={kind}
      data-image-asset={asset ?? ""}
      data-image-query={query}
      data-image-prompt={prompt ?? ""}
      data-image-ratio={ratio}
      data-image-alt={alt}
    >
      {image ? (
        <img src={image.src} alt={alt} width={image.width} height={image.height} loading={priority ? "eager" : "lazy"} decoding="async" style={focus ? { objectPosition: focus } : undefined} />
      ) : (
        <span className="site-image__placeholder" role="img" aria-label={alt} />
      )}
      {image?.source === "pexels" && image.credit && (
        <figcaption className="site-image__credit">
          <a href={image.creditUrl} target="_blank" rel="noreferrer">{image.credit} / Pexels</a>
        </figcaption>
      )}
    </figure>
  );
}
