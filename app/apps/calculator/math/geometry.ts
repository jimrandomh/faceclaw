// The parts of geometry the calculator's spoken-question surface reaches:
// shapes, triangle-from-sides, and Pythagoras.

// ---------------------------------------------------------------------------
// Triangles

/** A triangle solved from whatever three parts were given. */
export type Triangle = {
  /** Side lengths, opposite the same-named angles. */
  a: number;
  b: number;
  c: number;
  /** Angles in radians. */
  angleA: number;
  angleB: number;
  angleC: number;
};

export function triangleArea(triangle: Triangle): number {
  // Heron's formula, in the numerically stable ordering: the naive form
  // loses most of its precision on a needle-thin triangle.
  const sides = [triangle.a, triangle.b, triangle.c].sort((p, q) => q - p);
  const [x, y, z] = [sides[0]!, sides[1]!, sides[2]!];
  const term = (x + (y + z)) * (z - (x - y)) * (z + (x - y)) * (x + (y - z));
  return term <= 0 ? 0 : Math.sqrt(term) / 4;
}

export function trianglePerimeter(triangle: Triangle): number {
  return triangle.a + triangle.b + triangle.c;
}

export function triangleKind(triangle: Triangle): string {
  const tolerance = 1e-9;
  const sides = [triangle.a, triangle.b, triangle.c].sort((p, q) => p - q);
  const descriptors: string[] = [];
  if (Math.abs(sides[0]! - sides[2]!) < tolerance) {
    descriptors.push("equilateral");
  } else if (Math.abs(sides[0]! - sides[1]!) < tolerance || Math.abs(sides[1]! - sides[2]!) < tolerance) {
    descriptors.push("isosceles");
  } else {
    descriptors.push("scalene");
  }
  const largest = Math.max(triangle.angleA, triangle.angleB, triangle.angleC);
  if (Math.abs(largest - Math.PI / 2) < 1e-6) {
    descriptors.push("right");
  } else if (largest > Math.PI / 2) {
    descriptors.push("obtuse");
  } else {
    descriptors.push("acute");
  }
  return descriptors.join(", ");
}

export function triangleAnglesInDegrees(triangle: Triangle): [number, number, number] {
  return [
    (triangle.angleA * 180) / Math.PI,
    (triangle.angleB * 180) / Math.PI,
    (triangle.angleC * 180) / Math.PI,
  ];
}

export type TriangleResult =
  | { kind: "one"; triangle: Triangle }
  /**
   * SSA can genuinely produce two valid triangles. Returning one and calling
   * it solved is the classic wrong answer in this topic.
   */
  | { kind: "two"; first: Triangle; second: Triangle }
  | { kind: "impossible"; reason: string };

/**
 * Guards acos/asin against a value a hair outside [-1, 1] from rounding,
 * which returns NaN and poisons everything downstream.
 */
function clampedToUnit(value: number): number {
  return Math.min(1, Math.max(-1, value));
}

/** Three sides. */
export function triangleFromSides(a: number, b: number, c: number): TriangleResult {
  if (a <= 0 || b <= 0 || c <= 0) return { kind: "impossible", reason: "Sides must be positive" };
  if (a + b <= c || b + c <= a || a + c <= b) {
    return { kind: "impossible", reason: "Those sides cannot close a triangle" };
  }
  const angleA = Math.acos(clampedToUnit((b * b + c * c - a * a) / (2 * b * c)));
  const angleB = Math.acos(clampedToUnit((a * a + c * c - b * b) / (2 * a * c)));
  return {
    kind: "one",
    triangle: { a, b, c, angleA, angleB, angleC: Math.PI - angleA - angleB },
  };
}

// ---------------------------------------------------------------------------
// Shapes

export type Shape =
  | { kind: "circle"; radius: number }
  | { kind: "rectangle"; width: number; height: number }
  | { kind: "square"; side: number }
  | { kind: "triangleBaseHeight"; base: number; height: number }
  | { kind: "trapezoid"; a: number; b: number; height: number }
  | { kind: "parallelogram"; base: number; height: number }
  | { kind: "regularPolygon"; sides: number; sideLength: number }
  | { kind: "ellipse"; a: number; b: number }
  // Solids
  | { kind: "sphere"; radius: number }
  | { kind: "cylinder"; radius: number; height: number }
  | { kind: "cone"; radius: number; height: number }
  | { kind: "cube"; side: number }
  | { kind: "rectangularPrism"; length: number; width: number; height: number }
  | { kind: "pyramid"; baseArea: number; height: number };

export function shapeName(shape: Shape): string {
  switch (shape.kind) {
    case "circle":
      return "circle";
    case "rectangle":
      return "rectangle";
    case "square":
      return "square";
    case "triangleBaseHeight":
      return "triangle";
    case "trapezoid":
      return "trapezoid";
    case "parallelogram":
      return "parallelogram";
    case "regularPolygon":
      return `regular ${shape.sides}-gon`;
    case "ellipse":
      return "ellipse";
    case "sphere":
      return "sphere";
    case "cylinder":
      return "cylinder";
    case "cone":
      return "cone";
    case "cube":
      return "cube";
    case "rectangularPrism":
      return "rectangular prism";
    case "pyramid":
      return "pyramid";
  }
}

export function shapeIsSolid(shape: Shape): boolean {
  switch (shape.kind) {
    case "sphere":
    case "cylinder":
    case "cone":
    case "cube":
    case "rectangularPrism":
    case "pyramid":
      return true;
    default:
      return false;
  }
}

/** Area for a plane figure; surface area for a solid. */
export function shapeArea(shape: Shape): number | null {
  switch (shape.kind) {
    case "circle":
      return Math.PI * shape.radius * shape.radius;
    case "rectangle":
      return shape.width * shape.height;
    case "square":
      return shape.side * shape.side;
    case "triangleBaseHeight":
      return (shape.base * shape.height) / 2;
    case "trapezoid":
      return ((shape.a + shape.b) * shape.height) / 2;
    case "parallelogram":
      return shape.base * shape.height;
    case "regularPolygon":
      return shape.sides >= 3
        ? (shape.sides * shape.sideLength * shape.sideLength) / (4 * Math.tan(Math.PI / shape.sides))
        : null;
    case "ellipse":
      return Math.PI * shape.a * shape.b;
    case "sphere":
      return 4 * Math.PI * shape.radius * shape.radius;
    case "cylinder":
      return 2 * Math.PI * shape.radius * (shape.radius + shape.height);
    case "cone":
      return (
        Math.PI *
        shape.radius *
        (shape.radius + Math.sqrt(shape.radius * shape.radius + shape.height * shape.height))
      );
    case "cube":
      return 6 * shape.side * shape.side;
    case "rectangularPrism":
      return (
        2 *
        (shape.length * shape.width + shape.length * shape.height + shape.width * shape.height)
      );
    case "pyramid":
      return null; // needs the base shape, not just its area
  }
}

export function shapePerimeter(shape: Shape): number | null {
  switch (shape.kind) {
    case "circle":
      return 2 * Math.PI * shape.radius;
    case "rectangle":
      return 2 * (shape.width + shape.height);
    case "square":
      return 4 * shape.side;
    case "regularPolygon":
      return shape.sides >= 3 ? shape.sides * shape.sideLength : null;
    case "ellipse": {
      // Ramanujan's second approximation — accurate to ~1e-9 for any
      // realistic eccentricity, where the naive π(a+b) is not close.
      const h = ((shape.a - shape.b) * (shape.a - shape.b)) / ((shape.a + shape.b) * (shape.a + shape.b));
      return Math.PI * (shape.a + shape.b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
    }
    default:
      // Trapezoid/triangle/parallelogram need every side, and the constructor
      // only took the measurements the area formula uses. Solids have none.
      return null;
  }
}

export function shapeVolume(shape: Shape): number | null {
  switch (shape.kind) {
    case "sphere":
      return (4 / 3) * Math.PI * shape.radius * shape.radius * shape.radius;
    case "cylinder":
      return Math.PI * shape.radius * shape.radius * shape.height;
    case "cone":
      return (Math.PI * shape.radius * shape.radius * shape.height) / 3;
    case "cube":
      return shape.side * shape.side * shape.side;
    case "rectangularPrism":
      return shape.length * shape.width * shape.height;
    case "pyramid":
      return (shape.baseArea * shape.height) / 3;
    default:
      return null;
  }
}

/** Everything known, for the readback. */
export function shapeSummary(shape: Shape): [string, number][] {
  const parts: [string, number][] = [];
  const area = shapeArea(shape);
  if (area !== null) parts.push([shapeIsSolid(shape) ? "Surface area" : "Area", area]);
  const perimeter = shapePerimeter(shape);
  if (perimeter !== null) parts.push(["Perimeter", perimeter]);
  const volume = shapeVolume(shape);
  if (volume !== null) parts.push(["Volume", volume]);
  return parts;
}

// ---------------------------------------------------------------------------
// Coordinate geometry

/** Pythagoras, either direction: give any two, get the third. */
export function pythagoras(
  a: number | null,
  b: number | null,
  hypotenuse: number | null,
): number | null {
  if (a !== null && b !== null && hypotenuse === null) return Math.sqrt(a * a + b * b);
  if (a !== null && b === null && hypotenuse !== null) {
    return hypotenuse > a ? Math.sqrt(hypotenuse * hypotenuse - a * a) : null;
  }
  if (a === null && b !== null && hypotenuse !== null) {
    return hypotenuse > b ? Math.sqrt(hypotenuse * hypotenuse - b * b) : null;
  }
  return null;
}
