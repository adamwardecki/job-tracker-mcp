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
// The button's own text changes, which screen readers do not reliably announce,
// so a polite live region repeats the result.
const copyStatus = document.createElement("div");
copyStatus.className = "visually-hidden";
copyStatus.setAttribute("role", "status");
document.body.append(copyStatus);
document.querySelectorAll("[data-copy]").forEach((button) => {
  button.addEventListener("click", async () => {
    const label = button.textContent;
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      button.textContent = "Copied!";
      copyStatus.textContent = "Copied to clipboard";
    } catch {
      button.textContent = "Select to copy";
      copyStatus.textContent = "Select the text, then copy it";
      const range = document.createRange();
      range.selectNodeContents(button.previousElementSibling);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    setTimeout(() => {
      button.textContent = label;
      copyStatus.textContent = "";
    }, 2000);
  });
});
// Each [data-video-dialog] button opens the modal <dialog> it names and plays
// that dialog's video: the click is the user's own gesture, so the browser
// allows sound. showModal() traps focus and handles Esc. A backdrop click and a
// click on the dialog's own padding both target the dialog element, so we
// compare the pointer to the dialog's box to tell them apart. The close handler
// pauses the video and refocuses the opener explicitly because a dialog closed
// via script is not guaranteed to restore it.
document.querySelectorAll("[data-video-dialog]").forEach((opener) => {
  const dialog = document.getElementById(opener.dataset.videoDialog);
  if (!dialog) return;
  const video = dialog.querySelector("video");
  opener.addEventListener("click", () => {
    dialog.showModal();
    // play() rejects if the browser refuses; the visible controls still work.
    video.play().catch(() => {});
  });
  dialog.querySelectorAll("[data-dialog-close]").forEach((close) => {
    close.addEventListener("click", () => dialog.close());
  });
  dialog.addEventListener("click", (e) => {
    if (e.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) dialog.close();
  });
  dialog.addEventListener("close", () => {
    video.pause();
    opener.focus();
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

// A shared field lets the original ripples cross slide backgrounds without
// clipping at each section. Keep it below the hero as content changes height.
const slideMain = document.querySelector("main:has(> .hero)");
if (slideMain) {
  const slides = [...slideMain.querySelectorAll(":scope > section:not(.hero)")];
  const strip = slideMain.querySelector(".belief-strip");
  const footer = document.querySelector("body > .site-footer");
  const ripples = document.createElement("div");
  ripples.className = "slide-ripples";
  ripples.setAttribute("aria-hidden", "true");
  slideMain.append(ripples);

  const fitRipples = () => {
    if (!slides.length) return;
    const mainBox = slideMain.getBoundingClientRect();
    const first = slides[0].getBoundingClientRect();
    const start = (strip ?? slides[0]).getBoundingClientRect();
    const end = (footer ?? slides.at(-1)).getBoundingClientRect();
    ripples.style.top = `${start.top - mainBox.top}px`;
    ripples.style.height = `${end.bottom - start.top}px`;
    // Extend the existing field upward without shifting the approved slide pattern.
    ripples.style.backgroundPositionY = `${-240 - (first.top - start.top)}px`;
  };
  const rippleObserver = new ResizeObserver(fitRipples);
  rippleObserver.observe(slideMain);
  slides.forEach((slide) => rippleObserver.observe(slide));
  if (strip) rippleObserver.observe(strip);
  if (footer) rippleObserver.observe(footer);
  fitRipples();
}
