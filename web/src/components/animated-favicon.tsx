"use client";

import { useEffect } from "react";

/**
 * Animated favicon — a rotating, pulsing Elder Sign, so the Peludo Labs tab is
 * findable at a glance in a crowded tab strip.
 *
 * WHY CANVAS AND NOT AN ANIMATED FILE: browsers do not animate favicons.
 * Chrome renders only the first frame of an animated GIF, and SVG favicons are
 * painted statically (SMIL/CSS animation inside them is ignored). The only
 * cross-browser way is to repaint an <link rel="icon"> href on a timer, which
 * is what this does.
 *
 * FRAME RATE IS DELIBERATELY LOW (~1.5 fps). Background tabs — precisely when
 * you are hunting for this one — have their timers clamped to about 1 s by
 * Chrome and Firefox, and can be throttled harder after a few minutes hidden.
 * A slow pulse survives that clamp and still reads as movement; a 30 fps spin
 * would just stutter and burn CPU. If the tab has been hidden a long time the
 * animation may pause entirely — that is the browser's budget throttling, not
 * a bug, and it resumes on focus.
 */
const SIZE = 32;
const FRAMES = 8;
const PERIOD_MS = 650;

function drawElderSign(ctx: CanvasRenderingContext2D, frame: number) {
  const c = SIZE / 2;
  const t = frame / FRAMES;
  ctx.clearRect(0, 0, SIZE, SIZE);

  // rounded brand-orange tile, pulsing between two brand shades
  const pulse = 0.5 + 0.5 * Math.sin(t * Math.PI * 2);
  const r = Math.round(198 + 24 * pulse);
  const g = Math.round(108 + 20 * pulse);
  const b = Math.round(38 + 14 * pulse);
  ctx.fillStyle = `rgb(${r},${g},${b})`;
  const radius = 7;
  ctx.beginPath();
  ctx.moveTo(radius, 0);
  ctx.arcTo(SIZE, 0, SIZE, SIZE, radius);
  ctx.arcTo(SIZE, SIZE, 0, SIZE, radius);
  ctx.arcTo(0, SIZE, 0, 0, radius);
  ctx.arcTo(0, 0, SIZE, 0, radius);
  ctx.closePath();
  ctx.fill();

  // five-pointed star, rotating one full turn per cycle
  const angle = t * Math.PI * 2;
  const outer = 12.5;
  const inner = 5.2;
  ctx.save();
  ctx.translate(c, c);
  ctx.rotate(angle);
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? outer : inner;
    const a = (Math.PI / 5) * i - Math.PI / 2;
    const x = Math.cos(a) * rad;
    const y = Math.sin(a) * rad;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = "#ffffff";
  ctx.fill();

  // the eye at its heart — kept counter-rotated so it never looks tumbling
  ctx.rotate(-angle);
  ctx.beginPath();
  ctx.arc(0, 0, 2.6, 0, Math.PI * 2);
  ctx.fillStyle = `rgb(${r},${g},${b})`;
  ctx.fill();
  ctx.restore();
}

export function AnimatedFavicon() {
  useEffect(() => {
    const canvas = document.createElement("canvas");
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Own a dedicated <link> so Next's static /icon.svg stays as the no-JS
    // fallback instead of being mutated.
    let link = document.querySelector<HTMLLinkElement>('link[rel="icon"][data-animated]');
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      link.type = "image/png";
      link.dataset.animated = "true";
      document.head.appendChild(link);
    }

    let frame = 0;
    const tick = () => {
      drawElderSign(ctx, frame);
      frame = (frame + 1) % FRAMES;
      try {
        link.href = canvas.toDataURL("image/png");
      } catch {
        /* canvas unavailable — keep the static icon */
      }
    };
    tick();
    const id = window.setInterval(tick, PERIOD_MS);
    return () => {
      window.clearInterval(id);
      link?.remove();
    };
  }, []);

  return null;
}
