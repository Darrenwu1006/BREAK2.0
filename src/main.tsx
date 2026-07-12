import { createRoot } from "react-dom/client";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "@fontsource/ibm-plex-mono/latin-700.css";
import { App } from "./App";
import "./index.css";

// dev 防呆：HMR 重執行本入口時重用既有 root，避免 double createRoot 的孤兒 React 樹
const w = window as unknown as { __breakRoot?: ReturnType<typeof createRoot> };
const root = (w.__breakRoot ??= createRoot(document.getElementById("root")!));
root.render(<App />);
