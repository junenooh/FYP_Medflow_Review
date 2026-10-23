/**
 * Product names are mostly stored in capitals ("HI-TAR SOLUTION 20%"). For display they are shown
 * in title case ("Hi-Tar Solution 20%"), with units in lower case ("500 MG" -> "500 mg").
 * Names already in mixed case ("Formet Tablet 500mg") are left alone, so this is safe to apply twice.
 */

const UNITS = new Set(["MG", "MCG", "G", "KG", "ML", "L", "IU", "MMOL", "MEQ", "UNITS", "VIAL", "VIALS"]);
const SMALL = new Set(["FOR", "OF", "AND", "WITH", "IN", "ON", "TO", "THE", "PER", "OR"]);

function titleWord(word, first, compound) {
  if (/\d/.test(word)) return word.replace(/[A-Z]+/g, (m) => (UNITS.has(m) ? m.toLowerCase() : m));
  if (UNITS.has(word)) return word.toLowerCase();
  if (!first && SMALL.has(word)) return word.toLowerCase();
  // Short standalone words are abbreviations (OD, IV, I.V., K.); inside "HI-TAR" they are not.
  if ((word.length <= 2 && !compound) || word.includes(".")) return word;
  return word.charAt(0) + word.slice(1).toLowerCase();
}

export function displayName(name) {
  const text = String(name || "").trim();
  const upper = (text.match(/[A-Z]/g) || []).length;
  const lower = (text.match(/[a-z]/g) || []).length;
  if (!text || upper <= lower * 2) return text;
  let first = true;
  return text.replace(/[A-Z0-9.%/+'’]+(?:-[A-Z0-9.%/+'’]+)*/g, (token) => {
    const parts = token.split("-");
    const out = parts.map((part, i) => titleWord(part, first && i === 0, parts.length > 1)).join("-");
    first = false;
    return out;
  });
}
