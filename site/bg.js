(function () {
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* Grille d'espace qui se déforme (canvas) */
  document.querySelectorAll("[data-warp]").forEach((canvas) => {
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let w = 0;
    let h = 0;
    let raf = null;
    let t = Math.random() * 10;

    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      const gap = w < 700 ? 34 : 52;

      for (let x = -gap; x <= w + gap; x += gap) {
        ctx.beginPath();
        for (let y = -12; y <= h + 12; y += 14) {
          const dx =
            Math.sin(y * 0.011 + t * 0.55) * gap * 0.34 +
            Math.sin(y * 0.026 - t * 0.8) * gap * 0.14;
          if (y === -12) ctx.moveTo(x + dx, y);
          else ctx.lineTo(x + dx, y);
        }
        const major = Math.round(x / gap) % 4 === 0;
        ctx.strokeStyle = major ? "rgba(200,56,47,0.14)" : "rgba(200,56,47,0.065)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      for (let y = -gap; y <= h + gap; y += gap) {
        ctx.beginPath();
        for (let x = -12; x <= w + 12; x += 14) {
          const dy =
            Math.sin(x * 0.009 + t * 0.45) * gap * 0.3 +
            Math.sin(x * 0.02 + t * 0.7) * gap * 0.12;
          if (x === -12) ctx.moveTo(x, y + dy);
          else ctx.lineTo(x, y + dy);
        }
        const major = Math.round(y / gap) % 4 === 0;
        ctx.strokeStyle = major ? "rgba(200,56,47,0.12)" : "rgba(200,56,47,0.055)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = Math.max(1, Math.round(rect.width));
      h = Math.max(1, Math.round(rect.height));
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw();
    };

    const loop = () => {
      t += 0.01;
      draw();
      raf = requestAnimationFrame(loop);
    };

    if (typeof ResizeObserver === "function") {
      new ResizeObserver(resize).observe(canvas);
    } else {
      window.addEventListener("resize", resize);
    }

    resize();

    if (!reduce) {
      raf = requestAnimationFrame(loop);
      document.addEventListener("visibilitychange", () => {
        if (document.hidden) {
          if (raf) cancelAnimationFrame(raf);
          raf = null;
        } else if (!raf) {
          raf = requestAnimationFrame(loop);
        }
      });
    }
  });

  /* Halo qui suit le curseur */
  const stage = document.querySelector('.bg-stage');
  if (stage && window.matchMedia("(pointer: fine)").matches) {
    let tx = window.innerWidth * 0.5;
    let ty = window.innerHeight * 0.2;
    let cx = tx;
    let cy = ty;
    let raf = null;

    const paint = () => {
      cx += (tx - cx) * 0.16;
      cy += (ty - cy) * 0.16;
      stage.style.setProperty("--mx", cx + "px");
      stage.style.setProperty("--my", cy + "px");
      if (Math.abs(tx - cx) > 0.5 || Math.abs(ty - cy) > 0.5) {
        raf = requestAnimationFrame(paint);
      } else {
        raf = null;
      }
    };

    window.addEventListener(
      "pointermove",
      (e) => {
        tx = e.clientX;
        ty = e.clientY;
        if (!raf) raf = requestAnimationFrame(paint);
      },
      { passive: true }
    );
  }

  /* Choix du fond : ?bg=gloss|space|aurora|topo|halo */
  const params = new URLSearchParams(window.location.search);
  const bg = params.get("bg");
  if (bg && ["gloss", "space", "aurora", "topo", "halo"].includes(bg)) {
    document.body.dataset.bg = bg;
  }
})();
