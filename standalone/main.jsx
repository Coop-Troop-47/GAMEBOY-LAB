import React from "react";
import { createRoot } from "react-dom/client";
import "../app/globals.css";
import Emulator from "../app/Emulator.jsx";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <Emulator />
  </React.StrictMode>,
);
