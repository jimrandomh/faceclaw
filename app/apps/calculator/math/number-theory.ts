// Integer arithmetic: primality, factorisation, modular arithmetic, and the
// classic sequences. Modular products use BigInt internally — `(a*b) % m`
// in floats loses exactness long before the moduli a cryptography-flavoured
// question uses.

// ---------------------------------------------------------------------------
// Primality

const SMALL_PRIMES = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37];

/**
 * Deterministic Miller-Rabin. The witness set below is *proven* to decide
 * primality for every 64-bit integer, so this is exact rather than
 * probabilistic.
 */
export function isPrime(value: number): boolean {
  if (!Number.isSafeInteger(value) || value < 2) return false;
  for (const small of SMALL_PRIMES) {
    if (value === small) return true;
    if (value % small === 0) return false;
  }
  let d = BigInt(value - 1);
  let r = 0;
  while (d % 2n === 0n) {
    d /= 2n;
    r += 1;
  }

  const n = BigInt(value);
  for (const witness of SMALL_PRIMES) {
    let x = modularPowerBig(BigInt(witness), d, n);
    if (x === 1n || x === n - 1n) continue;
    let composite = true;
    for (let step = 0; step < r - 1; step++) {
      x = (x * x) % n;
      if (x === n - 1n) {
        composite = false;
        break;
      }
    }
    if (composite) return false;
  }
  return true;
}

/** The next prime at or above `value`, or null when the search is unreasonable. */
export function nextPrime(after: number): number | null {
  let candidate = Math.max(2, after + 1);
  // Bounded: a caller asking near the integer ceiling should get null, not a hang.
  while (Number.isSafeInteger(candidate) && candidate - after < 1_000_000) {
    if (isPrime(candidate)) return candidate;
    candidate += 1;
  }
  return null;
}

export function primesUpTo(limit: number): number[] {
  if (limit < 2) return [];
  const sieve = new Uint8Array(limit + 1).fill(1);
  sieve[0] = 0;
  sieve[1] = 0;
  for (let candidate = 2; candidate * candidate <= limit; candidate++) {
    if (!sieve[candidate]) continue;
    for (let multiple = candidate * candidate; multiple <= limit; multiple += candidate) {
      sieve[multiple] = 0;
    }
  }
  const result: number[] = [];
  for (let value = 2; value <= limit; value++) {
    if (sieve[value]) result.push(value);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Factorisation

export type PrimeFactor = { prime: number; exponent: number };

/**
 * Trial division by small primes, then Pollard's rho for the rest.
 *
 * Trial division alone is fine to ~10⁷ and hopeless beyond; rho handles
 * semiprimes with large factors, which is exactly the shape that makes a
 * naive factoriser appear to hang.
 */
export function factorize(value: number): PrimeFactor[] {
  if (value === 0 || !Number.isSafeInteger(value)) return [];
  let remaining = Math.abs(value);
  const counts = new Map<number, number>();

  for (const prime of primesUpTo(100_000)) {
    if (prime * prime > remaining) break;
    while (remaining % prime === 0) {
      counts.set(prime, (counts.get(prime) ?? 0) + 1);
      remaining /= prime;
    }
  }
  if (remaining > 1) {
    for (const factor of pollardFactorize(remaining)) {
      counts.set(factor, (counts.get(factor) ?? 0) + 1);
    }
  }
  return [...counts.keys()].sort((a, b) => a - b).map((prime) => ({ prime, exponent: counts.get(prime)! }));
}

function pollardFactorize(value: number): number[] {
  if (value === 1) return [];
  if (isPrime(value)) return [value];
  const divisor = pollardRho(value);
  if (divisor === null) return [value];
  return [...pollardFactorize(divisor), ...pollardFactorize(value / divisor)];
}

function pollardRho(n: number): number | null {
  if (n % 2 === 0) return 2;
  const big = BigInt(n);
  // Deterministic sequence of offsets rather than a random one: the same
  // input must factor the same way every run, or a test is a coin flip.
  for (let offset = 1n; offset <= 40n; offset++) {
    let x = 2n;
    let y = 2n;
    let divisor = 1n;
    while (divisor === 1n) {
      x = (x * x + offset) % big;
      y = (y * y + offset) % big;
      y = (y * y + offset) % big;
      divisor = gcdBig(absBig(x - y), big);
    }
    if (divisor !== big) return Number(divisor);
  }
  return null;
}

function absBig(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function gcdBig(a: bigint, b: bigint): bigint {
  let x = a;
  let y = b;
  while (y !== 0n) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x;
}

export function divisorsOf(value: number): number[] {
  const magnitude = Math.abs(value);
  if (magnitude <= 0) return [];
  let result: number[] = [1];
  for (const factor of factorize(magnitude)) {
    const expanded: number[] = [];
    let power = 1;
    for (let step = 0; step <= factor.exponent; step++) {
      expanded.push(...result.map((existing) => existing * power));
      power *= factor.prime;
    }
    result = expanded;
  }
  return result.sort((a, b) => a - b);
}

/**
 * σ(n) and τ(n) come free from the factorisation and are what "perfect
 * number" and "abundant" questions actually need.
 */
export function divisorSum(value: number): number {
  return factorize(Math.abs(value)).reduce((total, factor) => {
    let term = 1;
    let power = 1;
    for (let step = 0; step < factor.exponent; step++) {
      power *= factor.prime;
      term += power;
    }
    return total * term;
  }, 1);
}

export function divisorCount(value: number): number {
  return factorize(Math.abs(value)).reduce((total, factor) => total * (factor.exponent + 1), 1);
}

/** Euler's totient. */
export function totient(value: number): number {
  if (value <= 0) return 0;
  let result = value;
  for (const factor of factorize(value)) {
    result = (result / factor.prime) * (factor.prime - 1);
  }
  return result;
}

// ---------------------------------------------------------------------------
// GCD / LCM

export function greatestCommonDivisor(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const next = x % y;
    x = y;
    y = next;
  }
  return x;
}

export function leastCommonMultiple(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return Math.abs((a / greatestCommonDivisor(a, b)) * b);
}

/** Extended Euclid: returns `[gcd, x, y]` with `ax + by = gcd`. */
export function extendedGCD(a: number, b: number): [number, number, number] {
  if (b === 0) return [Math.abs(a), a < 0 ? -1 : 1, 0];
  const [gcd, x, y] = extendedGCD(b, a % b);
  return [gcd, y, x - Math.floor(a / b) * y];
}

// ---------------------------------------------------------------------------
// Modular arithmetic

/**
 * Always non-negative, unlike `%`. JavaScript's `%` on a negative left
 * operand returns a negative remainder, which is wrong for every modular use
 * here.
 */
export function mod(value: number, modulus: number): number {
  if (modulus === 0) return 0;
  const remainder = value % modulus;
  return remainder < 0 ? remainder + Math.abs(modulus) : remainder;
}

function modularPowerBig(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let b = base % modulus;
  if (b < 0n) b += modulus;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus;
    b = (b * b) % modulus;
    e >>= 1n;
  }
  return result;
}

export function modularPower(base: number, exponent: number, modulus: number): number {
  if (modulus <= 1) return 0;
  if (exponent < 0) {
    const inverse = modularInverse(base, modulus);
    if (inverse === null) return 0;
    return modularPower(inverse, -exponent, modulus);
  }
  return Number(modularPowerBig(BigInt(base), BigInt(exponent), BigInt(modulus)));
}

/**
 * null when `value` and `modulus` are not coprime — an inverse genuinely
 * does not exist, and returning 0 would look like an answer.
 */
export function modularInverse(value: number, modulus: number): number | null {
  if (modulus <= 1) return null;
  const [gcd, x] = extendedGCD(mod(value, modulus), modulus);
  if (gcd !== 1) return null;
  return mod(x, modulus);
}

// ---------------------------------------------------------------------------
// Sequences

/** null past fib(78) — the largest that stays an exact double. */
export function fibonacci(n: number): number | null {
  if (n < 0) return null;
  if (n === 0) return 0;
  let a = 0;
  let b = 1; // fib(0), fib(1)
  // Stop one short and return `b`, so a representable answer is never
  // reported as overflow by computing fib(n+1) as a side effect.
  for (let step = 1; step < n; step++) {
    const next = a + b;
    if (!Number.isSafeInteger(next)) return null;
    a = b;
    b = next;
  }
  return b;
}

export function binomial(n: number, k: number): number | null {
  if (n < 0 || k < 0 || k > n) return null;
  const kk = Math.min(k, n - k);
  let result = 1;
  for (let step = 0; step < kk; step++) {
    // Multiply then divide keeps every intermediate an integer, and the
    // division is always exact at this point.
    const product = result * (n - step);
    if (!Number.isSafeInteger(product)) return null;
    result = product / (step + 1);
  }
  return result;
}

/**
 * Digit sum, digital root, and palindrome are the recreational-maths staples
 * a spoken question actually reaches for.
 */
export function digitSum(value: number): number {
  let remaining = Math.abs(value);
  let total = 0;
  while (remaining > 0) {
    total += remaining % 10;
    remaining = Math.floor(remaining / 10);
  }
  return total;
}

export function digitalRoot(value: number): number {
  const magnitude = Math.abs(value);
  return magnitude === 0 ? 0 : 1 + ((magnitude - 1) % 9);
}

export function isPalindrome(value: number): boolean {
  const text = String(Math.abs(value));
  return text === [...text].reverse().join("");
}

export function isPerfect(value: number): boolean {
  return value > 1 && divisorSum(value) - value === value;
}

// ---------------------------------------------------------------------------
// Reporting

/** A full dossier on one integer, which is what "tell me about 5,040" means. */
export type IntegerReport = {
  value: number;
  isPrime: boolean;
  factorization: PrimeFactor[];
  divisorCount: number;
  divisorSum: number;
  totient: number;
  digitSum: number;
  digitalRoot: number;
  isPerfect: boolean;
  isPalindrome: boolean;
};

export function factorizationText(report: IntegerReport): string {
  if (report.factorization.length === 0) return String(report.value);
  return report.factorization
    .map((factor) => (factor.exponent === 1 ? `${factor.prime}` : `${factor.prime}^${factor.exponent}`))
    .join(" × ");
}

export function integerReport(value: number): IntegerReport {
  return {
    value,
    isPrime: isPrime(value),
    factorization: factorize(value),
    divisorCount: divisorCount(value),
    divisorSum: divisorSum(value),
    totient: totient(Math.abs(value)),
    digitSum: digitSum(value),
    digitalRoot: digitalRoot(value),
    isPerfect: isPerfect(value),
    isPalindrome: isPalindrome(value),
  };
}
