import React from "react";
import { createRoot } from "react-dom/client";
import { DesktopApp as App } from "./ConnectedApp.jsx";
import "./styles.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
