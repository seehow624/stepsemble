/* The thinking level as a line to drag: the weakest level on the left, the
   strongest on the right, one stop per level of the model's own list. Two
   lines share the machinery here. The model sheet's slider stands in for the
   level select, which stays in the page (hidden) as the record the rest of
   the app reads and writes: the slider shows whatever the select holds. The
   message box's top edge shows what the composer shows, as the app tells it.
   A level the person settles on is committed once per drag, tap or key step.
   The line follows the finger 1:1 from where it was taken, can be caught
   mid-flight, and on release lands on a stop, settling on a spring
   (critically damped; the sheet's thumb lands where a flick was heading,
   with a little bounce). Reduced motion lands it at once. Pure helpers are
   shared with the tests. */
(function exposeStepsembleEffortSlider(root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.stepsembleEffortSlider = Object.freeze(api);
})(typeof window !== "undefined" ? window : null, () => {
  "use strict";

  const LEVEL_ORDER = Object.freeze(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
  const NO_LEVEL = new Set(["off", "none"]);
  const AUTO_LEVEL = new Set(["auto", "default"]);
  // Apple's projection: where a released thumb would come to rest. A slider
  // is short, so the snappier rate.
  const DECELERATION = 0.99;
  const FLICK = 500; // px/s: a release faster than this is a flick and may overshoot
  const GRAB = 22; // px either side of the thumb's centre that take the thumb itself
  // On the message box's edge the weakest level is a short stub of the line.
  const STUB = 0.1;

  const rank = value => NO_LEVEL.has(value) ? -1 : LEVEL_ORDER.indexOf(value);
  const isOff = value => NO_LEVEL.has(String(value ?? "").toLowerCase());

  /**
   * The slider's stops from the select's entries: the levels that can be
   * picked, weakest first. Off/none is the leftmost; auto is not a stop.
   * @param entries [{ value, label?, disabled? }] or level names
   * @returns {{ stops: string[], labels: Map<string,string>, auto: string|null }} auto: the value that picks auto, when offered
   */
  function levelStops(entries) {
    const labels = new Map();
    let auto = null;
    const values = [];
    for (const entry of Array.isArray(entries) ? entries : []) {
      const item = entry && typeof entry === "object" ? entry : { value: entry };
      const value = String(item.value ?? "").trim();
      if (!value || item.disabled) continue;
      if (AUTO_LEVEL.has(value.toLowerCase())) { auto ??= value; continue; }
      if (labels.has(value)) continue;
      labels.set(value, String(item.label ?? "").trim() || value);
      values.push(value);
    }
    // Known levels are ranked (Grok lists Extra high first); a list with
    // names of its own keeps its order, with off first.
    const known = values.every(value => NO_LEVEL.has(value.toLowerCase()) || LEVEL_ORDER.includes(value.toLowerCase()));
    const stops = known ? [...values].sort((a, b) => rank(a.toLowerCase()) - rank(b.toLowerCase()))
      : [...values.filter(value => NO_LEVEL.has(value.toLowerCase())), ...values.filter(value => !NO_LEVEL.has(value.toLowerCase()))];
    return { stops, labels, auto };
  }

  /** A stop's place on the line, 0 at the left and 1 at the right; a lone level sits at the strong end. */
  function stopFraction(index, count) { return count > 1 ? Math.min(1, Math.max(0, index / (count - 1))) : 1; }

  /** The stop nearest a place on the line (0..1). */
  function nearestStop(fraction, count) {
    if (count < 2) return 0;
    return Math.min(count - 1, Math.max(0, Math.round(Number(fraction) * (count - 1))));
  }

  /**
   * A stop's place on the message box's edge: off is the empty line, the
   * weakest level a short stub and the strongest the whole line, the rest
   * evenly between. Stops come weakest first, off before them.
   */
  function linePlace(index, stops) {
    const list = Array.isArray(stops) ? stops : [];
    if (!(index >= 0 && index < list.length) || isOff(list[index])) return 0;
    const off = list.filter(isOff).length, count = list.length - off;
    return count > 1 ? STUB + (1 - STUB) * (index - off) / (count - 1) : 1;
  }

  /** The stop whose place (0..1) is nearest; the stronger of two as near. */
  function nearestPlace(fraction, places) {
    let best = 0;
    for (let index = 1; index < places.length; index++) if (Math.abs(places[index] - fraction) <= Math.abs(places[best] - fraction)) best = index;
    return best;
  }

  /** How far a release at this velocity (px/s) carries on. */
  function project(velocity, rate = DECELERATION) { return (Number(velocity) / 1000) * rate / (1 - rate); }

  /** The stop a release lands on: nearest to where it was heading. */
  function landingStop({ position, velocity, width, count }) {
    if (count < 2 || !(width > 0)) return 0;
    return nearestStop((position + project(velocity)) / width, count);
  }

  // Past either end the thumb slows, as if held back, and never runs off.
  function rubberband(over, dimension = 28, constant = 0.55) {
    return (over * dimension * constant) / (dimension + constant * Math.abs(over));
  }

  // One step of a damped spring (mass 1), as Apple describes it: a response
  // in seconds and a damping ratio, 1 for no overshoot.
  function springStep(state, target, dt, { response = 0.32, damping = 1 } = {}) {
    const stiffness = (2 * Math.PI / response) ** 2, friction = 4 * Math.PI * damping / response;
    let { x, v } = state;
    for (let left = dt; left > 0; left -= 1 / 240) {
      const h = Math.min(1 / 240, left);
      v += (-stiffness * (x - target) - friction * v) * h;
      x += v * h;
    }
    return { x, v };
  }

  function reducedMotion() {
    if (typeof document === "undefined") return false;
    return document.documentElement.classList.contains("reduced-motion")
      || !!(typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches);
  }

  /**
   * The machinery under both lines: a place in px a finger drags, a spring
   * that lands it on a stop, keys that step it. set() says what to show:
   * { stops, labels, current, auto, disabled, hidden, name, shown } (name is
   * the slider's value text, shown the value element's when at rest).
   * `commit(level)` takes a level settled on. `place(index, stops)` is a
   * stop's place on the line; `momentum` lands a release where it was
   * heading; `slop` makes a finger move that far sideways before it drags,
   * so a tap jumps and a scroll that starts on the line is no change.
   */
  function drive({ slider, track, fill = null, thumb = null, ticks = null, tick = "effort-tick", value = null, box = slider, commit,
    place = (index, stops) => stopFraction(index, stops.length), momentum = true, slop = 0, focusOnPress = true }) {
    const doc = slider.ownerDocument, win = doc.defaultView;
    let state = { stops: [], labels: new Map(), current: -1, auto: false, disabled: true, hidden: true, name: "", shown: "" };
    let stops = [], current = -1, live = -1, width = 0, frame = 0, last = 0, landing = 0;
    // The line's place in px from its left end, its velocity, and what
    // drives it: nothing, a finger, or a spring towards `target`.
    let x = 0, v = 0, target = 0, mode = "idle", spring = { response: 0.32, damping: 1 };
    let drag = null, press = null, keyPending = null;

    const at = index => index >= 0 && stops.length ? place(index, stops) : 0;
    const nearest = fraction => stops.length ? nearestPlace(fraction, stops.map((stop, index) => at(index))) : -1;
    const fraction = () => width > 0 ? Math.min(1, Math.max(0, x / width)) : at(current);
    function paint() {
      const p = fraction();
      box.style.setProperty("--effort-p", p.toFixed(4));
      box.style.setProperty("--effort-w", width + "px");
      box.style.setProperty("--effort-x", (width > 0 ? Math.max(0, Math.min(width, x)) : 0).toFixed(2) + "px");
      if (thumb) thumb.style.transform = `translate3d(${width > 0 ? x.toFixed(2) : 0}px, 0, 0)`;
      if (fill) fill.style.width = (width > 0 ? Math.max(0, Math.min(width, x)) : p * 100) + (width > 0 ? "px" : "%");
      const shown = mode === "idle" && !drag ? current : nearest(p);
      ticks?.querySelectorAll("." + tick).forEach((mark, index) => mark.classList.toggle("on", stops.length > 1 && index <= shown && shown >= 0));
      box.classList.toggle("is-top", shown >= 0 && shown === stops.length - 1 && !isOff(stops[shown]) && !(state.auto && mode === "idle" && !drag));
    }
    function setLive(index, { feedback = false } = {}) {
      if (index === live) return;
      live = index;
      const label = index >= 0 ? state.labels.get(stops[index]) || stops[index] : "";
      if (value && label) value.textContent = label;
      // A detent under the finger, where the device can tell.
      if (feedback) { try { win.navigator.vibrate?.(4); } catch {} }
    }
    // A moment after a level is picked its name stays up.
    function landed() {
      box.classList.add("is-landing");
      win.clearTimeout(landing);
      landing = win.setTimeout(() => box.classList.remove("is-landing"), 900);
    }

    // The line's own width, unaffected by a sheet that is still scaling in.
    function measure() { width = track ? track.offsetWidth : 0; }
    function restingX() { return width * at(current); }

    function run() {
      if (frame) return;
      last = 0;
      frame = win.requestAnimationFrame(step);
    }
    function step(time) {
      frame = 0;
      const dt = last ? Math.min(0.05, (time - last) / 1000) : 1 / 60;
      last = time;
      if (mode === "spring" || mode === "catch-up") {
        ({ x, v } = springStep({ x, v }, target, dt, spring));
        if (Math.abs(x - target) < 0.3 && Math.abs(v) < 6) {
          x = target; v = 0;
          mode = mode === "catch-up" ? "drag" : "idle";
        }
      }
      paint();
      if (mode === "spring" || mode === "catch-up") frame = win.requestAnimationFrame(step);
      else last = 0;
    }
    function settle(to, velocity = 0) {
      target = to;
      if (reducedMotion() || width <= 0) { x = to; v = 0; mode = "idle"; paint(); return; }
      v = velocity;
      // Bounce only when the gesture carried momentum.
      spring = { response: 0.34, damping: momentum && Math.abs(velocity) > FLICK ? 0.78 : 1 };
      mode = "spring";
      run();
    }

    function set(next) {
      state = { ...state, ...next };
      const changed = state.stops.join("\u0000") !== stops.join("\u0000");
      stops = state.stops; current = state.current;
      if (changed && ticks) {
        ticks.replaceChildren(...stops.map((stop, index) => {
          const mark = doc.createElement("span");
          mark.className = tick;
          mark.style.left = at(index) * 100 + "%";
          return mark;
        }));
      }
      const { hidden, disabled } = state;
      for (const node of [slider, value, box.querySelector(".effort-ends")]) if (node) node.hidden = hidden;
      box.classList.toggle("is-empty", hidden);
      box.classList.toggle("is-auto", !!state.auto);
      box.classList.toggle("is-unknown", current < 0);
      box.classList.toggle("is-disabled", disabled);
      box.dataset.stops = String(stops.length);
      slider.setAttribute("aria-valuemin", "0");
      slider.setAttribute("aria-valuemax", String(Math.max(0, stops.length - 1)));
      slider.setAttribute("aria-valuenow", String(Math.max(0, current)));
      slider.setAttribute("aria-valuetext", state.name || "—");
      slider.setAttribute("aria-disabled", String(disabled));
      slider.tabIndex = disabled || hidden ? -1 : 0;
      if (drag) return; // the finger leads; the line catches up when it lets go
      live = current;
      if (value) value.textContent = state.shown;
      const before = width;
      measure();
      const to = restingX();
      // Shown for the first time, or hidden: no journey to watch.
      if (!before || !width) { if (frame) { win.cancelAnimationFrame(frame); frame = 0; } x = to; v = 0; mode = "idle"; paint(); return; }
      if (mode === "spring" && Math.abs(target - to) < 0.5) return;
      if (mode === "idle" && Math.abs(x - to) < 0.5) { paint(); return; }
      settle(to, mode === "spring" ? v : 0);
    }

    function pick(index) {
      const level = stops[index];
      if (level === undefined) return;
      current = index;
      commit(level);
    }

    // Pointer: take the line where it ends, or tap it to jump.
    function pointerX(clientX) {
      const rect = track.getBoundingClientRect();
      return (clientX - rect.left) * (rect.width ? width / rect.width : 1);
    }
    function begin(pointerId, clientX, time, touch) {
      try { slider.setPointerCapture(pointerId); } catch {}
      if (focusOnPress) slider.focus({ preventScroll: true });
      const at = pointerX(clientX), onThumb = Math.abs(at - x) <= GRAB;
      // Caught mid-flight, the line stays where it is on screen.
      if (frame) { win.cancelAnimationFrame(frame); frame = 0; }
      drag = { id: pointerId, offset: onThumb ? at - x : 0, finger: at, history: [{ at, time }], touch };
      box.classList.add("is-dragging");
      if (onThumb || reducedMotion()) { if (!onThumb) x = at; mode = "drag"; v = 0; paint(); }
      else { target = at; spring = { response: 0.2, damping: 1 }; mode = "catch-up"; run(); }
      setLive(nearest(onThumb ? fraction() : at / width));
    }
    function follow(clientX, time) {
      const at = pointerX(clientX);
      drag.finger = at;
      drag.history.push({ at, time });
      while (drag.history.length > 2 && time - drag.history[0].time > 100) drag.history.shift();
      let wanted = at - drag.offset;
      if (wanted < 0) wanted = rubberband(wanted);
      else if (wanted > width) wanted = width + rubberband(wanted - width);
      if (mode === "catch-up") target = wanted;
      else { x = wanted; paint(); }
      setLive(nearest((mode === "catch-up" ? wanted : x) / width), { feedback: drag.touch });
    }
    slider.addEventListener("pointerdown", event => {
      if (state.disabled || stops.length < 2 || (event.pointerType === "mouse" && event.button !== 0)) return;
      // The line takes no focus from the text box (nor its keyboard away).
      event.preventDefault();
      measure();
      if (!width) return;
      if (slop && event.pointerType !== "mouse") {
        press = { id: event.pointerId, x: event.clientX, y: event.clientY };
        box.classList.add("is-pressed");
        try { slider.setPointerCapture(event.pointerId); } catch {}
        return;
      }
      begin(event.pointerId, event.clientX, event.timeStamp, event.pointerType !== "mouse");
    });
    slider.addEventListener("pointermove", event => {
      if (press && event.pointerId === press.id) {
        const dx = event.clientX - press.x, dy = event.clientY - press.y;
        if (Math.max(Math.abs(dx), Math.abs(dy)) < slop) return;
        const from = press; press = null;
        box.classList.remove("is-pressed");
        // Up or down is not this line's.
        if (Math.abs(dy) > Math.abs(dx)) { try { slider.releasePointerCapture(event.pointerId); } catch {} return; }
        begin(event.pointerId, from.x, event.timeStamp, true);
      }
      if (!drag || event.pointerId !== drag.id) return;
      follow(event.clientX, event.timeStamp);
    });
    function release(event) {
      if (press && event.pointerId === press.id) {
        // A tap: the stop under it.
        press = null;
        box.classList.remove("is-pressed");
        if (event.type !== "pointerup") return;
        const index = nearest(pointerX(event.clientX) / width);
        setLive(index); landed();
        settle(width * at(index));
        if (index >= 0 && (index !== current || state.auto)) pick(index);
        return;
      }
      if (!drag || event.pointerId !== drag.id) return;
      const { history, finger, offset } = drag;
      drag = null;
      box.classList.remove("is-dragging");
      // The velocity of the last moment before letting go: a finger that
      // stopped and then lifted throws nothing.
      const recent = [...history, { at: history[history.length - 1].at, time: event.timeStamp }].filter(sample => event.timeStamp - sample.time <= 100);
      const first = recent[0], end = recent[recent.length - 1];
      const velocity = recent.length > 1 && end.time > first.time ? (end.at - first.at) / ((end.time - first.time) / 1000) : 0;
      // A tap on the line lands where it was tapped, not where the thumb has got to.
      const catching = mode === "catch-up", from = catching ? finger - offset : x;
      const index = event.type === "pointercancel" ? current
        : nearest((Math.max(0, Math.min(width, from)) + (momentum ? project(velocity) : 0)) / width);
      mode = "idle";
      settle(index >= 0 ? width * at(index) : restingX(), catching ? v : velocity);
      setLive(index); landed();
      if (index >= 0 && (index !== current || state.auto)) pick(index);
      else set(state);
    }
    slider.addEventListener("pointerup", release);
    slider.addEventListener("pointercancel", release);
    slider.addEventListener("lostpointercapture", event => {
      if (press && event.pointerId === press.id) { press = null; box.classList.remove("is-pressed"); }
      if (drag && event.pointerId === drag.id) release(event);
    });

    // Keys: a step lands on its stop; one held down lands where it is let go.
    slider.addEventListener("keydown", event => {
      if (state.disabled || !stops.length) return;
      const count = stops.length, page = Math.max(1, Math.round((count - 1) / 2));
      const base = keyPending ?? (current >= 0 ? current : 0);
      const next = { ArrowRight: base + 1, ArrowUp: base + 1, ArrowLeft: base - 1, ArrowDown: base - 1,
        PageUp: base + page, PageDown: base - page, Home: 0, End: count - 1 }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      const index = Math.min(count - 1, Math.max(0, current < 0 && keyPending === null && /Arrow|Page/.test(event.key) ? 0 : next));
      measure();
      setLive(index); landed();
      settle(width * at(index));
      if (event.repeat) { keyPending = index; return; }
      keyPending = null;
      if (index !== current || state.auto) pick(index);
    });
    slider.addEventListener("keyup", () => {
      if (keyPending === null) return;
      const index = keyPending;
      keyPending = null;
      if (index !== current || state.auto) pick(index);
    });
    slider.addEventListener("blur", () => { if (keyPending !== null) { const index = keyPending; keyPending = null; pick(index); } });

    // A new width (the sheet opened, the window resized) keeps the line's place.
    if (win.ResizeObserver && track) new win.ResizeObserver(() => {
      const before = width;
      measure();
      if (!before || !width || mode === "idle" && !drag) { x = restingX(); target = x; v = 0; paint(); return; }
      const scale = width / before;
      x *= scale; v *= scale; target *= scale;
      if (drag) drag.offset *= scale;
      paint();
    }).observe(track);
    return { set, pick, current: () => current };
  }

  /**
   * Draws the slider into `slider` (role="slider") and keeps it in step with
   * `select`. `value` shows the level's name, `auto` is the Auto chip and
   * `control` the block whose state classes the styles read.
   */
  function attach({ select, slider, value = null, auto = null, control = null }) {
    if (!select || !slider || slider.dataset.effortSlider) return null;
    slider.dataset.effortSlider = "on";
    const win = slider.ownerDocument.defaultView;
    let autoValue = null, autoActive = false, queued = false;
    const line = drive({ slider, track: slider.querySelector(".effort-track"), fill: slider.querySelector(".effort-fill"),
      ticks: slider.querySelector(".effort-ticks"), thumb: slider.querySelector(".effort-thumb"), value, box: control || slider,
      commit(level) {
        if (select.value === level && !autoActive) { read(); return; }
        select.value = level;
        select.dispatchEvent(new win.Event("change", { bubbles: true }));
      } });

    // The select is the record: read it whenever it may have changed.
    function read() {
      queued = false;
      const options = [...select.options];
      const next = levelStops(options.map(option => ({ value: option.value, label: option.textContent, disabled: option.disabled })));
      const chosen = options[select.selectedIndex] || null;
      const chosenValue = chosen ? chosen.value : "";
      autoActive = AUTO_LEVEL.has(chosenValue.toLowerCase()) || !!chosen?.dataset?.auto;
      const effective = autoActive ? String(chosen?.dataset?.effective || "") : "";
      autoValue = next.auto;
      const current = next.stops.indexOf(autoActive ? effective : chosenValue);
      const disabled = !!select.disabled || next.stops.length === 0, hidden = !!select.hidden;
      if (auto) {
        auto.hidden = hidden || (!autoValue && !autoActive);
        auto.setAttribute("aria-pressed", String(autoActive));
        auto.disabled = disabled && !autoValue;
      }
      const name = chosen ? chosen.textContent.trim() : "";
      line.set({ stops: next.stops, labels: next.labels, current, auto: autoActive, disabled, hidden, name: name || "—",
        // Under the pressed Auto chip, the level auto runs at.
        shown: autoActive ? (current >= 0 ? next.labels.get(next.stops[current]) || "" : "") : name || "—" });
    }
    function queue() {
      if (queued) return;
      queued = true;
      queueMicrotask(read);
    }

    // Auto: picked when offered; pressed again, it leaves auto at the level it runs at.
    auto?.addEventListener("click", () => {
      if (autoActive) { if (line.current() >= 0) line.pick(line.current()); return; }
      if (!autoValue) return;
      select.value = autoValue;
      select.dispatchEvent(new win.Event("change", { bubbles: true }));
    });

    // Every way the app changes the select: its options and states, and its value.
    const observer = new win.MutationObserver(queue);
    observer.observe(select, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["disabled", "hidden", "data-auto", "data-effective"] });
    const proto = Object.getOwnPropertyDescriptor(win.HTMLSelectElement.prototype, "value");
    if (proto?.set) {
      Object.defineProperty(select, "value", { configurable: true, enumerable: true,
        get() { return proto.get.call(this); },
        set(next) { proto.set.call(this, next); queue(); } });
    }
    select.addEventListener("change", queue);
    read();
    return { refresh: read };
  }

  /**
   * The thinking level along the message box's top edge (`slider`, with a
   * .effort-line-track, -fill, -ticks, -tip and -label inside). The app says
   * what to show with set(); a level the person settles on goes to
   * `commit(level)`, which returns false when it cannot take it. Its release
   * lands on the nearest level on a critically damped spring.
   */
  function attachLine({ slider, commit }) {
    if (!slider || slider.dataset.effortSlider) return null;
    slider.dataset.effortSlider = "on";
    let shown = null;
    const line = drive({ slider, track: slider.querySelector(".effort-line-track"), fill: slider.querySelector(".effort-line-fill"),
      ticks: slider.querySelector(".effort-line-ticks"), tick: "effort-line-tick", thumb: slider.querySelector(".effort-line-tip"),
      value: slider.querySelector(".effort-line-label"), place: linePlace, momentum: false, slop: 8, focusOnPress: false,
      commit(level) { if (commit(level) === false && shown) line.set(shown); } });
    return { set(next) { shown = next; line.set(next); } };
  }

  return { levelStops, stopFraction, nearestStop, linePlace, nearestPlace, project, landingStop, rubberband, springStep, attach, attachLine, LEVEL_ORDER };
});
