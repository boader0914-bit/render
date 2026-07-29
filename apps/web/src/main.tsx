import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@glamping-datalab-v2/ui/styles.css";
import "./app.css";
import { App } from "./App";
import { registerPwa } from "./pwa";

registerPwa();

const root = document.getElementById("root");
if (!root) throw new Error("V2 UI root is missing.");
createRoot(root).render(<StrictMode><App /></StrictMode>);
