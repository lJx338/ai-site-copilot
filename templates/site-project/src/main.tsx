import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./app/App";
import { HashRouter } from "./app/router";
import "./styles/tokens.css";
import "./styles/globals.css";
import "./styles/system.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>,
);
