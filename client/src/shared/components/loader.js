import { animate, createScope } from "animejs";

/**
 * <medflow-loader> — the MedFlow capsule inside a spinning ring.
 * Idle: ring orbits, capsule rocks and its halves breathe apart.
 * Interactive: the mark leans toward the cursor; click/tap bursts it open and snaps it shut.
 * Animation starts on connect and is reverted on disconnect, so it is safe inside any
 * innerHTML render that data later replaces.
 */
class MedflowLoader extends HTMLElement {
  connectedCallback() {
    this.innerHTML = `
      <button type="button" class="ml-mark" data-mark aria-label="Loading. Tap to play the animation.">
        <svg viewBox="0 0 96 96" aria-hidden="true" focusable="false">
          <circle class="ml-ring-track" cx="48" cy="48" r="42" />
          <circle class="ml-ring" data-ring cx="48" cy="48" r="42" />
          <g data-lean>
            <g class="ml-capsule" data-capsule>
              <path class="ml-half ml-half-a" data-half="a" d="M36 38H48V58H36A10 10 0 0 1 36 38Z" />
              <path class="ml-half ml-half-b" data-half="b" d="M48 38H60A10 10 0 0 1 60 58H48Z" />
            </g>
          </g>
        </svg>
      </button>
    `;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const mark = this.querySelector("[data-mark]");
    const ring = this.querySelector("[data-ring]");
    const lean = this.querySelector("[data-lean]");
    const capsule = this.querySelector("[data-capsule]");
    const halfA = this.querySelector('[data-half="a"]');
    const halfB = this.querySelector('[data-half="b"]');

    this.scope = createScope({ root: this }).add(() => {
      animate(ring, { rotate: 360, duration: 1500, ease: "linear", loop: true });
      animate(capsule, { rotate: [-38, -22], duration: 1300, ease: "inOutSine", alternate: true, loop: true });
      animate(halfA, { x: [0, -2.5], duration: 1300, ease: "inOutSine", alternate: true, loop: true });
      animate(halfB, { x: [0, 2.5], duration: 1300, ease: "inOutSine", alternate: true, loop: true });

      mark.addEventListener("pointermove", (event) => {
        const box = mark.getBoundingClientRect();
        const dx = (event.clientX - (box.left + box.width / 2)) / (box.width / 2);
        const dy = (event.clientY - (box.top + box.height / 2)) / (box.height / 2);
        animate(lean, { x: dx * 6, y: dy * 6, duration: 300, ease: "out(3)" });
      });
      mark.addEventListener("pointerleave", () => {
        animate(lean, { x: 0, y: 0, duration: 600, ease: "outElastic(1, .6)" });
      });
      mark.addEventListener("click", () => {
        animate(halfA, { x: [-12, -2.5], duration: 900, ease: "outElastic(1, .5)" });
        animate(halfB, { x: [12, 2.5], duration: 900, ease: "outElastic(1, .5)" });
        animate(ring, { scale: [1, 1.08, 1], duration: 600, ease: "outQuad" });
      });
    });
  }

  disconnectedCallback() {
    this.scope?.revert();
    this.scope = null;
  }
}

if (!customElements.get("medflow-loader")) {
  customElements.define("medflow-loader", MedflowLoader);
}
