// Turns "1,234.56" (thousands+decimal) into "1234.56" and "1.234,56" /
// "1234,56" (decimal comma) into "1234.56", instead of blindly replacing the
// first comma — which mangled thousands-separated amounts.
export function normalizeAmount(raw: string): string | null {
  let s = raw.trim();
  if (s.includes(",") && s.includes(".")) {
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) {
      s = s.replace(/\./g, "").replace(",", ".");
    } else {
      s = s.replace(/,/g, "");
    }
  } else if (s.includes(",")) {
    s = s.replace(",", ".");
  }
  return /^\d+(\.\d+)?$/.test(s) ? s : null;
}
