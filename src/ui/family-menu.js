import { FAMILY_SITES } from "../family-sites.js";
import { escapeHtml } from "./format.js";

// Dropdown under the title linking to the sibling tools listed in
// src/family-sites.js. Disabled when this is the only site in the list.
export function initFamilyMenu({ titleMenuToggle, titleMenu }, currentSiteName) {
  const otherSites = FAMILY_SITES.filter((site) => site.name !== currentSiteName);
  if (!otherSites.length) {
    titleMenuToggle.disabled = true;
    return;
  }

  titleMenu.innerHTML = otherSites
    .map(
      (site) => `
        <a class="title-menu-item" href="${escapeHtml(site.url)}">
          <span class="title-menu-item-name">${escapeHtml(site.name)}</span>
          <span class="title-menu-item-desc">${escapeHtml(site.description)}</span>
        </a>`
    )
    .join("");

  const setOpen = (open) => {
    titleMenu.hidden = !open;
    titleMenuToggle.setAttribute("aria-expanded", String(open));
  };

  titleMenuToggle.addEventListener("click", (event) => {
    event.stopPropagation();
    setOpen(titleMenuToggle.getAttribute("aria-expanded") !== "true");
  });
  document.addEventListener("click", (event) => {
    if (!titleMenu.hidden && !titleMenu.contains(event.target) && event.target !== titleMenuToggle) {
      setOpen(false);
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setOpen(false);
  });
}
