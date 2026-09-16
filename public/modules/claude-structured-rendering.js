(function expose(root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.stepsembleClaudeStructuredRendering = Object.freeze(api);
})(typeof window !== "undefined" ? window : null, () => {
  "use strict";

  // Claude's stream-json transport can report one turn three times: as
  // incremental content_block_delta events, a complete assistant message,
  // and the final result envelope. This controller reconciles those phases
  // for one logical turn only. It deliberately does not remember text across
  // turns, because two separate prompts may legitimately receive identical
  // replies.
  // The Host validates each structured event before it reaches the browser.
  // Keep a larger bounded mirror for reconciliation, but never truncate a
  // valid event's visible text at the old 64 KiB terminal-tail size.
  const MAX_TRACKED_TEXT = 8 * 1024 * 1024;
  const TEXT_EVENTS = new Set(["stream_event", "assistant", "result"]);

  function plain(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  function boundedText(value) {
    return typeof value === "string" ? value : "";
  }

  function contentText(message) {
    if (!plain(message)) return "";
    if (typeof message.content === "string") return boundedText(message.content);
    if (!Array.isArray(message.content)) return "";
    return message.content
      .filter(part => plain(part) && part.type === "text" && typeof part.text === "string")
      .map(part => part.text)
      .join("");
  }

  function streamEventText(event) {
    if (typeof event.delta === "string") return boundedText(event.delta);
    if (plain(event.delta) && typeof event.delta.text === "string") return boundedText(event.delta.text);
    if (typeof event.text === "string") return boundedText(event.text);
    const nested = plain(event?.event) ? event.event : {};
    const delta = plain(nested.delta) ? nested.delta : null;
    // --include-partial-messages emits content_block_delta/text_delta for the
    // live answer. Do not surface thinking/tool deltas as assistant prose.
    if (delta && (delta.type === "text_delta" || typeof delta.text === "string")) return boundedText(delta.text);
    if (nested.type === "content_block_start") {
      const block = plain(nested.content_block) ? nested.content_block : null;
      if (block?.type === "text") return boundedText(block.text);
    }
    return "";
  }

  function eventText(event) {
    if (!plain(event)) return "";
    if (event.type === "stream_event") return streamEventText(event);
    if (event.type === "assistant") return contentText(event.message) || boundedText(event.text);
    if (event.type === "result") return boundedText(event.result) || contentText(event.message) || boundedText(event.text);
    return "";
  }

  function messageIdentity(event) {
    if (!plain(event)) return null;
    const nested = event.type === "stream_event" && plain(event.event) ? event.event : event;
    const message = plain(nested.message) ? nested.message : null;
    // Never use stream_event.uuid here: Claude may assign a different UUID to
    // each partial frame. The message id is stable for the whole turn.
    for (const value of [message?.id, message?.message_id, nested.message_id]) {
      if (typeof value === "string" && value.length > 0 && value.length <= 256) return value;
    }
    return null;
  }

  function createRenderer() {
    let turnNumber = 0;
    let active = null;

    function start(identity = null) {
      turnNumber += 1;
      active = {
        key: identity ? `message:${identity}` : `turn:${turnNumber}`,
        identity,
        text: "",
        partialText: "",
        finalText: "",
        trackedTruncated: false,
        ended: false,
      };
      return active;
    }

    function track(turn, field, value) {
      const previous = turn[field] || "";
      const next = previous + String(value || "");
      if (next.length <= MAX_TRACKED_TEXT) {
        turn[field] = next;
        return next;
      }
      turn[field] = next.slice(-MAX_TRACKED_TEXT);
      turn.trackedTruncated = true;
      return turn[field];
    }

    function turnFor(event) {
      const identity = messageIdentity(event);
      // A duplicated result envelope is still the same completed turn. A new
      // assistant/partial event (or an explicit user envelope) starts the next
      // turn below; keeping result-on-result in place prevents a replay from
      // appending the final answer a second time.
      if (event.type === "result" && active?.ended && (!identity || identity === active.identity)) return active;
      if (!active || active.ended || identity && active.identity && identity !== active.identity) return start(identity);
      if (identity && !active.identity) active.identity = identity;
      return active;
    }

    function consume(event) {
      if (!plain(event)) return null;
      if (event.type === "user") {
        // The user envelope's message id belongs to the prompt, not the
        // assistant turn that follows it. Keep the turn unkeyed until the
        // assistant/stream message id arrives.
        start();
        return null;
      }
      if (!TEXT_EVENTS.has(event.type)) return null;

      const turn = turnFor(event);
      const phase = event.type === "stream_event" ? "partial" : event.type;
      const text = eventText(event);
      if (event.type === "result") turn.ended = true;
      if (!text) return null;

      const previous = turn.text;
      if (!previous) {
        turn.text = text.length <= MAX_TRACKED_TEXT ? text : text.slice(-MAX_TRACKED_TEXT);
        turn.trackedTruncated = text.length > MAX_TRACKED_TEXT;
        if (phase === "partial") turn.partialText = turn.text;
        else turn.finalText = text;
        return { mode: "append", text, beginTurn: true, turnKey: turn.key, phase };
      }

      // text_delta frames are already incremental. Preserve repeated chunks
      // such as "ha" + "ha"; event replay is bounded by the caller's event
      // index, so global string de-duplication would lose real content.
      if (phase === "partial") {
        track(turn, "text", text);
        track(turn, "partialText", text);
        return { mode: "append", text, beginTurn: false, turnKey: turn.key, phase };
      }

      // A complete assistant/result payload supersedes the partial prefix.
      // Equal final payloads are the normal assistant + result duplicate and
      // are intentionally ignored. Only a known partial prefix may be
      // replaced: a non-prefix complete payload is appended so a second
      // assistant message/content block can never erase the first one.
      if (text === previous || text === turn.finalText || previous.startsWith(text)) return null;
      const partial = turn.partialText;
      if (!turn.trackedTruncated && partial && text.startsWith(partial)) {
        turn.text = text;
        turn.finalText = text;
        return { mode: "replace", text, beginTurn: false, turnKey: turn.key, phase };
      }

      track(turn, "text", text);
      turn.finalText = text;
      return { mode: "append", text, beginTurn: false, turnKey: turn.key, phase };
    }

    return Object.freeze({
      consume,
      reset() { turnNumber = 0; active = null; },
      snapshot() { return active ? Object.freeze({ ...active }) : null; },
    });
  }

  return Object.freeze({ createRenderer, eventText, messageIdentity });
});
