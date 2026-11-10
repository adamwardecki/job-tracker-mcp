// A decorative example, not a live chat. Keep the whole conversation readable with reduced motion.
(() => {
  const chat = document.querySelector(".laptop-chat");
  if (!chat) return;
  const steps = [...chat.querySelectorAll("[data-chat-at]")];
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  let timers = [];
  let loaded = document.readyState === "complete";

  const clear = () => {
    timers.forEach(clearTimeout);
    timers = [];
  };
  const later = (callback, delay) => timers.push(setTimeout(callback, delay));
  const replay = () => {
    clear();
    for (const step of steps) {
      step.classList.toggle("is-visible", motion.matches && !step.hasAttribute("data-chat-until"));
    }
    if (motion.matches || document.hidden) return;
    for (const step of steps) {
      later(() => step.classList.add("is-visible"), 1000 + Number(step.dataset.chatAt));
      if (step.hasAttribute("data-chat-until")) {
        later(() => step.classList.remove("is-visible"), 1000 + Number(step.dataset.chatUntil));
      }
    }
    // Hold the completed list long enough to read, then leave a quiet beat before the next conversation.
    later(replay, 15000);
  };

  if (loaded) replay();
  else window.addEventListener("load", () => { loaded = true; replay(); }, { once: true });
  motion.addEventListener("change", () => { if (loaded) replay(); });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clear();
    else if (loaded) replay();
  });
})();
