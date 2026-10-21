import { fileURLToPath } from "node:url";

// Current checkout entry point. Historical fixtures and download names are independent.
export const APP_FILE_NAME = "leaf-note.html";
export const APP_PATH = fileURLToPath(
  new URL(`../${APP_FILE_NAME}`, import.meta.url),
);
