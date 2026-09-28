import { clearMaterials, uploadMaterial } from "@/lib/preview-client";

export const runtime = "nodejs";

const ALLOWED = /\.(pdf|xlsx|docx|csv|md|txt|png|jpe?g|webp|gif)$/i;

// 上传资料：浏览器逐个文件把原始字节发到这里（?name=文件名），转存到预览服务，原件不进项目工作区。
// 不用 multipart：框架把所有 multipart POST 当成 Server Action，限制 1MB，画册 PDF 传不上来。
// 上传后在对话里发一句话，Agent 会先读资料、给出资料卡，确认后再建站。
export async function POST(request: Request) {
  const url = new URL(request.url);
  const projectId = url.searchParams.get("projectId") || "coffee-studio";
  const name = url.searchParams.get("name") || "";
  if (!ALLOWED.test(name)) return Response.json({ error: `暂不支持这种文件类型：${name || "未命名文件"}` }, { status: 400 });
  try {
    const data = await request.arrayBuffer();
    if (!data.byteLength) return Response.json({ error: "文件是空的" }, { status: 400 });
    return Response.json(await uploadMaterial(projectId, name, data));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "上传失败" }, { status: 400 });
  }
}

export async function DELETE(request: Request) {
  const projectId = new URL(request.url).searchParams.get("projectId") || "coffee-studio";
  await clearMaterials(projectId);
  return Response.json({ ok: true });
}
