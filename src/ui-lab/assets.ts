// ui-lab 專用卡圖 helper。刻意不 import src/ui/（雙棧隔離，spec §0）；
// 邏輯對齊 src/ui/CardView.tsx 的 cardImage/cardBackImage，但 3D 貼圖用全尺寸卡背（非 thumb）。

import type { Card } from "../data/types";

const publicAsset = (path: string): string => `${import.meta.env.BASE_URL}${path.replace(/^\/+/, "")}`;

export function cardFrontUrl(card: Card): string | null {
  const p = card.printings[0];
  return p?.image ? publicAsset(p.image) : null;
}

const BACK_EXTENSIONS: Record<string, "png" | "jpg"> = {
  伊達工業: "png",
  梟谷: "png",
  烏野: "png",
  白鳥沢: "png",
  稲荷崎: "jpg",
  青葉城西: "png",
  音駒: "png",
};

export function cardBackUrl(school?: string): string {
  const normalized = school === "稻荷崎" ? "稲荷崎" : school;
  const name = normalized && BACK_EXTENSIONS[normalized] ? normalized : "default";
  const ext = normalized ? (BACK_EXTENSIONS[normalized] ?? "png") : "png";
  return publicAsset(`backs/${name}.${name === "default" ? "png" : ext}`);
}
