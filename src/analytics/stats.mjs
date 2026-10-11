// Small statistics shared by the analytics. Pure functions; they run in Node and the browser.

/** Linear-interpolated quantile, q in [0, 1] (NumPy's default). null for no values. */
export function quantile(xs, q) {
  if (!xs.length) return null;
  const a = Float64Array.from(xs).sort();
  const i = q * (a.length - 1);
  const lo = Math.floor(i);
  return a[lo] + (a[Math.min(lo + 1, a.length - 1)] - a[lo]) * (i - lo);
}

/** Quantile of the non-null values. */
export const q = (xs, p) => quantile(xs.filter((x) => x != null), p);

export const sum = (xs) => xs.reduce((s, x) => s + (x ?? 0), 0);

export function groupBy(xs, key) {
  const m = new Map();
  for (const x of xs) {
    const k = key(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

const mean = (xs) => sum(xs) / xs.length;
const variance = (xs) => {
  const m = mean(xs);
  return mean(xs.map((x) => (x - m) ** 2));
};

/**
 * Least squares y = b0 + b1 x1 + ... with an intercept. X: columns of regressors.
 * Returns { b: [b0, b1, ...], r2 }.
 */
export function ols(y, X) {
  const n = y.length;
  const cols = [new Array(n).fill(1), ...X];
  const k = cols.length;
  // Normal equations, solved by Gauss-Jordan elimination with partial pivoting.
  const A = cols.map((ci) => [...cols.map((cj) => ci.reduce((s, v, r) => s + v * cj[r], 0)), ci.reduce((s, v, r) => s + v * y[r], 0)]);
  for (let c = 0; c < k; c++) {
    let p = c;
    for (let r = c + 1; r < k; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < k; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let j = c; j <= k; j++) A[r][j] -= f * A[c][j];
    }
  }
  const b = A.map((row, i) => row[k] / row[i]);
  const res = y.map((v, r) => v - cols.reduce((s, col, j) => s + b[j] * col[r], 0));
  return { b, r2: 1 - variance(res) / variance(y) };
}

export function pearson(x, y) {
  const mx = mean(x), my = mean(y);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < x.length; i++) (sxy += (x[i] - mx) * (y[i] - my)), (sxx += (x[i] - mx) ** 2), (syy += (y[i] - my) ** 2);
  return sxy / Math.sqrt(sxx * syy);
}

/** Rank correlation. Ties take consecutive ranks in input order. */
export function spearman(x, y) {
  const rank = (a) => {
    const idx = a.map((_, i) => i).sort((i, j) => a[i] - a[j]);
    const r = new Array(a.length);
    idx.forEach((i, k) => (r[i] = k));
    return r;
  };
  return pearson(rank(x), rank(y));
}
