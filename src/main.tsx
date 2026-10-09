import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

// Local-first fonts (SIL OFL, bundled — no runtime network, offline-ready).
import "@fontsource-variable/plus-jakarta-sans";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "@fontsource-variable/source-serif-4";

import "./styles/tokens.css";
import "./index.css";
import App from "./App";
import { initAccount } from "@/lib/account/boot";

// The optional account: start the session and tie sync to it before the first
// render, so the app's own start-up already sees who is signed in. Inert in a
// build with no backend.
initAccount();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
