import { createElement as h } from "react";
import { ImageResponse } from "next/og";

export async function GET(_request: Request, context: { params: Promise<{ size: string }> }) {
  const size = Number((await context.params).size);
  if (size !== 192 && size !== 512) return new Response("Not found", { status: 404 });
  return new ImageResponse(h("div", { style: { display: "flex", width: "100%", height: "100%", background: "#0a0d0c", alignItems: "center", justifyContent: "center" } },
    h("svg", { width: size * .6, height: size * .6, viewBox: "0 0 32 32" },
      h("circle", { cx: 16, cy: 16, r: 16, fill: "#3fe0a0" }),
      h("path", { d: "M9 21.5c0-6.6 4.6-11.2 14-11.5-.2 9.4-4.9 14-11.5 14-.9 0-1.7-.1-2.5-.3Z", fill: "#04140d" }),
      h("path", { d: "M9.5 22.5 17 15", stroke: "#3fe0a0", strokeWidth: 1.6, strokeLinecap: "round" }))), { width: size, height: size });
}
