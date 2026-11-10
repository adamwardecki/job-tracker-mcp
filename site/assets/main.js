"use strict";

const tabs = [...document.querySelectorAll("[role=tab]")];
function selectTab(tab) {
  tabs.forEach((t) => {
    const active = t === tab;
    t.setAttribute("aria-selected", String(active));
    t.tabIndex = active ? 0 : -1;
    document.getElementById(t.getAttribute("aria-controls")).hidden = !active;
  });
}
tabs.forEach((tab, index) => {
  tab.addEventListener("click", () => selectTab(tab));
  tab.addEventListener("keydown", (e) => {
    let next;
    if (e.key === "ArrowRight") next = (index + 1) % tabs.length;
    if (e.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
    if (e.key === "Home") next = 0;
    if (e.key === "End") next = tabs.length - 1;
    if (next !== undefined) {
      e.preventDefault();
      selectTab(tabs[next]);
      tabs[next].focus();
    }
  });
});
document.querySelectorAll("[data-copy]").forEach((button) => {
  button.addEventListener("click", async () => {
    const label = button.textContent;
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      button.textContent = "Copied!";
    } catch {
      button.textContent = "Select to copy";
      const range = document.createRange();
      range.selectNodeContents(button.previousElementSibling);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    setTimeout(() => (button.textContent = label), 2000);
  });
});
// The screen's four corners in the 1774 x 887 artwork are (1204, 374),
// (1517, 390), (1494, 597), (1181, 563). A projective transform keeps future
// HTML content on that plane, including when the mobile scene is cropped.
const gardenScene = document.querySelector(".garden-scene");
const laptopScreen = document.querySelector(".laptop-screen");
if (gardenScene && laptopScreen) {
  const screenProjection = [0.5708128250194434, -0.054714402269226615, 0, -0.0002684984673569914, -0.14503014815185986, 0.8830736082577542, 0, -3.0064638973793665e-05, 0, 0, 1, 0, 1204.0, 374.0, 0, 1];
  const fitLaptopScreen = () => {
    const scale = gardenScene.getBoundingClientRect().width / 1774;
    const matrix = screenProjection.map((value, index) =>
      [0, 1, 4, 5, 12, 13].includes(index) ? value * scale : value,
    );
    const transform = `matrix3d(${matrix.join(",")})`;
    laptopScreen.style.transform = transform;
    laptopScreen.style.visibility = "visible";
  };
  fitLaptopScreen();
  new ResizeObserver(fitLaptopScreen).observe(gardenScene);
}
