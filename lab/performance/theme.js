/* Apply the stored preference before painting the report. */
(() => {
  "use strict";
  const key = "performance-atlas.appearance";
  const system = window.matchMedia("(prefers-color-scheme: dark)");
  const choices = ["auto", "light", "dark"];
  let mode = "auto";
  try {
    const saved = localStorage.getItem(key);
    if (choices.includes(saved)) mode = saved;
  } catch {
    // Some browsers disable local file storage. The control still works in this tab.
  }
  function apply() {
    const theme = mode === "auto" ? (system.matches ? "dark" : "light") : mode;
    document.documentElement.dataset.theme = theme;
    const menu = document.getElementById("report-theme");
    if (menu) menu.value = mode;
    window.dispatchEvent(
      new CustomEvent("atlas-themechange", { detail: { mode, theme } }),
    );
  }
  apply();
  system.addEventListener("change", () => {
    if (mode === "auto") apply();
  });
  window.addEventListener("storage", (event) => {
    if (event.key !== key && event.key !== null) return;
    mode = choices.includes(event.newValue) ? event.newValue : "auto";
    apply();
  });
  document.addEventListener("DOMContentLoaded", () => {
    const menu = document.getElementById("report-theme");
    menu.value = mode;
    menu.addEventListener("change", () => {
      mode = choices.includes(menu.value) ? menu.value : "auto";
      try {
        localStorage.setItem(key, mode);
      } catch {
        /* Keep the in-tab choice. */
      }
      apply();
    });
  });
})();
