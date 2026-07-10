import { lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "@fontsource/ibm-plex-mono/latin-700.css";
import { App } from "./App";
import "./index.css";

// 雙入口並行（M9 spec §0）：?ui=lab → 新介面實驗線（lazy 載入，經典 bundle 不揹 three）
const UiLabApp = lazy(() => import("./ui-lab/UiLabApp"));
const isLab = new URLSearchParams(window.location.search).get("ui") === "lab";

createRoot(document.getElementById("root")!).render(
  isLab ? (
    <Suspense fallback={<div style={{ padding: 24, color: "#889" }}>載入 ui-lab…</div>}>
      <UiLabApp />
    </Suspense>
  ) : (
    <App />
  ),
);
