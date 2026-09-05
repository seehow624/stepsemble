"use strict";

// Deliberately limited to the vocabulary used by our checked-in schema. This
// is not a general JSON Schema engine. Unknown schema keywords fail at startup
// so extending the contract cannot silently weaken validation.
function createValidator(schema) {
  const keywords = new Set(["$schema", "$id", "$defs", "$ref", "title", "description", "type", "properties", "required", "additionalProperties", "items", "maxItems", "uniqueItems", "minLength", "maxLength", "pattern", "format", "minimum", "maximum", "const", "enum", "anyOf"]);
  const patterns = new WeakMap();
  const discriminators = new WeakMap();
  function check(node) {
    for (const key of Object.keys(node)) if (!keywords.has(key)) throw new Error(`Unsupported schema keyword: ${key}`);
    if (node.pattern) patterns.set(node, new RegExp(node.pattern, "u"));
    if (node.format && node.format !== "date-time") throw new Error("Unsupported schema format");
    if (node.$ref && (!node.$ref.startsWith("#/$defs/") || !Object.hasOwn(schema.$defs, node.$ref.slice(8)))) throw new Error("Unknown schema reference");
    for (const child of Object.values(node.properties || {})) check(child);
    for (const child of Object.values(node.$defs || {})) check(child);
    for (const child of node.anyOf || []) check(child);
    // Closed wire unions dispatch once, keeping 500-event replay validation linear.
    if (node.anyOf?.length && node.anyOf.every(child => typeof child.properties?.type?.const === "string" && child.required?.includes("type"))) {
      const choices = new Map(node.anyOf.map(child => [child.properties.type.const, child]));
      if (choices.size === node.anyOf.length) discriminators.set(node, choices);
    }
    if (node.items) check(node.items);
  }
  check(schema);
  const typeMatches = (type, value) => {
    if (type === "null") return value === null;
    if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
    if (type === "array") return Array.isArray(value);
    if (type === "integer") return Number.isSafeInteger(value);
    return typeof value === type;
  };
  const equal = (left, right) => {
    if (left === right) return true;
    if (!left || !right || typeof left !== "object" || typeof right !== "object" || Array.isArray(left) !== Array.isArray(right)) return false;
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && equal(left[key], right[key]));
  };
  function timestamp(value) {
    // RFC3339 offset required. Date.parse alone normalizes impossible dates.
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/i.exec(value);
    if (!match) return false;
    const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = match.slice(1).map(item => Number(item || 0));
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]
      && hour < 24 && minute < 60 && second < 60 && offsetHour < 24 && offsetMinute < 60;
  }
  function validate(definition, value) {
    if (!Object.hasOwn(schema.$defs, definition)) return { valid: false, code: "unknown_contract" };
    let visited = 0;
    function matches(node, current, depth = 0) {
      if (++visited > 100000 || depth > 64) return false;
      // Draft 2020-12 applies sibling constraints alongside $ref.
      if (node.$ref && !matches(schema.$defs[node.$ref.slice(8)], current, depth + 1)) return false;
      if (discriminators.has(node)) {
        const choice = current && discriminators.get(node).get(current.type);
        if (!choice || !matches(choice, current, depth + 1)) return false;
      } else if (node.anyOf && !node.anyOf.some(option => matches(option, current, depth + 1))) return false;
      if (node.type && !(Array.isArray(node.type) ? node.type : [node.type]).some(type => typeMatches(type, current))) return false;
      if (Object.hasOwn(node, "const") && !equal(node.const, current)) return false;
      if (node.enum && !node.enum.some(item => equal(item, current))) return false;
      if (typeof current === "string") {
        if (node.minLength !== undefined || node.maxLength !== undefined) {
          let length = 0;
          for (const character of current) {
            length++;
            if (node.maxLength !== undefined && length > node.maxLength) return false;
          }
          if (node.minLength !== undefined && length < node.minLength) return false;
        }
        if (patterns.has(node) && !patterns.get(node).test(current)) return false;
        if (node.format === "date-time" && !timestamp(current)) return false;
      }
      if (typeof current === "number") {
        if (!Number.isFinite(current) || node.minimum !== undefined && current < node.minimum || node.maximum !== undefined && current > node.maximum) return false;
      }
      if (Array.isArray(current)) {
        if (node.maxItems !== undefined && current.length > node.maxItems) return false;
        if (node.uniqueItems && current.some((item, index) => current.slice(0, index).some(previous => equal(item, previous)))) return false;
        if (node.items && !current.every(item => matches(node.items, item, depth + 1))) return false;
      } else if (current && typeof current === "object") {
        if (node.required?.some(key => !Object.hasOwn(current, key))) return false;
        const properties = node.properties || {};
        for (const key of Object.keys(current)) {
          if (Object.hasOwn(properties, key)) { if (!matches(properties[key], current[key], depth + 1)) return false; }
          else if (node.additionalProperties === false) return false;
        }
      }
      return true;
    }
    // Errors never echo payloads, keys, native paths or credentials.
    try { return matches(schema.$defs[definition], value) ? { valid: true } : { valid: false, code: "invalid_payload" }; }
    catch { return { valid: false, code: "invalid_payload" }; }
  }
  return Object.freeze({ validate });
}

module.exports = { createValidator };
