// Price arithmetic shared by the analytics. Pure; runs in Node and the browser.
// Prices are $/M tokens: { input, output, cacheRead, cacheWrite, tiers? }.

/** API vendor whose public prices apply to a route's model, whatever route served it; null when out of scope. */
export function vendorOf(route) {
  const id = route.split("/").pop().toLowerCase();
  if (id.includes("claude")) return "anthropic";
  if (/^gpt-\d/.test(id) || /^(o\d|codex)/.test(id)) return "openai";
  return null;
}

/** Rates for a request of `prompt` tokens: the highest long-context tier it passes (pi's calculateCost rule). */
export function tierRates(price, prompt) {
  let rates = price;
  let above = -1;
  for (const t of price.tiers ?? []) if (prompt > t.inputTokensAbove && t.inputTokensAbove > above) (rates = t), (above = t.inputTokensAbove);
  return rates;
}

/** USD for one request's tokens at a price; null without a price. */
export function usd(price, { input = 0, cacheRead = 0, cacheWrite = 0, out = 0 }) {
  if (!price) return null;
  const r = tierRates(price, input + cacheRead + cacheWrite);
  return (input * r.input + cacheRead * r.cacheRead + cacheWrite * r.cacheWrite + out * r.output) / 1e6;
}
