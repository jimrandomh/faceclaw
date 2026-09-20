import type { LlmToolDefinition } from "./llm-protocol";

/**
 * Generate a GBNF grammar (llama.cpp grammar dialect) that constrains a
 * Qwen-style tool call to be well-formed: one <tool_call> block whose JSON
 * names a real tool and whose arguments match that tool's schema. Used as a
 * *lazy* grammar — sampling is unconstrained until the model emits
 * <tool_call>, so plain text answers are unaffected, and once the block
 * closes the grammar is complete (the model can only end the message, which
 * serializes multi-call turns into one call per loop iteration — deliberate:
 * small models are far more reliable one call at a time).
 *
 * Our tool schemas are flat objects of string/number/boolean/enum properties.
 * Anything fancier degrades to a generic JSON value rule rather than failing.
 */

type JsonSchema = {
  type?: string;
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  description?: string;
};

/** Longest run of optional properties we'll enumerate subsets for. */
const MAX_SUBSET_PROPS = 5;

export function buildToolCallGrammar(tools: LlmToolDefinition[]): string | null {
  if (!tools.length) return null;
  const used = new Set<string>();
  const toolRules: string[] = [];
  for (let i = 0; i < tools.length; i++) {
    const args = argsRule(tools[i]!.input_schema as JsonSchema, used);
    toolRules.push(
      `tc${i} ::= "<tool_call>" nl "{" sp ${jsonKey("name")} sp ":" sp "\\"${gbnfEscape(
        tools[i]!.name,
      )}\\"" sp "," sp ${jsonKey("arguments")} sp ":" sp ${args} sp "}" nl "</tool_call>"`,
    );
  }
  used.add("sp");
  used.add("nl");

  const lines = [`root ::= ${toolRules.map((_, i) => `tc${i}`).join(" | ")}`, ...toolRules];
  for (const [name, rule] of SHARED_RULES) {
    if (used.has(name)) lines.push(rule);
  }
  return lines.join("\n");
}

/** Build the arguments-object expression for one tool schema. */
function argsRule(schema: JsonSchema | undefined, used: Set<string>): string {
  const properties = schema?.properties ?? {};
  const names = Object.keys(properties);
  if (!names.length) return `"{" sp "}"`;
  const required = new Set(schema?.required ?? []);
  const optionalCount = names.filter((n) => !required.has(n)).length;
  if (names.length > MAX_SUBSET_PROPS && optionalCount > 0) {
    used.add("jobj");
    return "jobj";
  }

  // Enumerate every subset of properties that includes all required ones,
  // keeping declaration order. Small N keeps this tiny (<= 2^5 alternatives).
  const members = names.map((name) => {
    const value = valueExpr(properties[name]!, used);
    return `${jsonKey(name)} sp ":" sp ${value}`;
  });
  const alternatives: string[] = [];
  for (let mask = 0; mask < 1 << names.length; mask++) {
    const chosen: string[] = [];
    let valid = true;
    for (let j = 0; j < names.length; j++) {
      const included = (mask & (1 << j)) !== 0;
      if (included) chosen.push(members[j]!);
      else if (required.has(names[j]!)) valid = false;
    }
    if (!valid) continue;
    if (!chosen.length) {
      alternatives.push(`"{" sp "}"`);
    } else {
      alternatives.push(`"{" sp ${chosen.join(` sp "," sp `)} sp "}"`);
    }
  }
  return alternatives.length === 1 ? alternatives[0]! : `(${alternatives.join(" | ")})`;
}

/** Grammar expression for one property value. */
function valueExpr(schema: JsonSchema, used: Set<string>): string {
  if (Array.isArray(schema.enum) && schema.enum.length) {
    if (schema.enum.every((v) => typeof v === "string")) {
      return `(${schema.enum.map((v) => `"\\"${gbnfEscape(String(v))}\\""`).join(" | ")})`;
    }
    if (schema.enum.every((v) => typeof v === "number" || typeof v === "boolean")) {
      return `(${schema.enum.map((v) => `"${String(v)}"`).join(" | ")})`;
    }
  }
  switch (schema.type) {
    case "string":
      used.add("jstring");
      used.add("jchar");
      used.add("jhex");
      return "jstring";
    case "number":
      used.add("jnumber");
      return "jnumber";
    case "integer":
      used.add("jint");
      return "jint";
    case "boolean":
      used.add("jbool");
      return "jbool";
    default:
      for (const name of ["jvalue", "jstring", "jchar", "jhex", "jnumber", "jbool", "jarray", "jobj", "jmember"]) {
        used.add(name);
      }
      return "jvalue";
  }
}

/** A JSON object key as a GBNF literal: "name" -> "\"name\"". */
function jsonKey(name: string): string {
  return `"\\"${gbnfEscape(name)}\\""`;
}

/** Escape for the inside of a GBNF double-quoted literal. */
function gbnfEscape(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

// Terminal rules, emitted only when referenced. jchar mirrors llama.cpp's
// json.gbnf string character rule.
const SHARED_RULES: Array<[string, string]> = [
  ["sp", `sp ::= " "?`],
  ["nl", `nl ::= "\\n"`],
  ["jstring", `jstring ::= "\\"" jchar* "\\""`],
  ["jchar", `jchar ::= [^"\\\\\\x7F\\x00-\\x1F] | "\\\\" (["\\\\bfnrt] | "u" jhex jhex jhex jhex)`],
  ["jhex", `jhex ::= [0-9a-fA-F]`],
  ["jnumber", `jnumber ::= "-"? ("0" | [1-9] [0-9]*) ("." [0-9]+)? (("e" | "E") ("-" | "+")? [0-9]+)?`],
  ["jint", `jint ::= "-"? ("0" | [1-9] [0-9]*)`],
  ["jbool", `jbool ::= "true" | "false"`],
  ["jvalue", `jvalue ::= jstring | jnumber | jbool | "null" | jarray | jobj`],
  ["jarray", `jarray ::= "[" sp (jvalue (sp "," sp jvalue)*)? sp "]"`],
  ["jobj", `jobj ::= "{" sp (jmember (sp "," sp jmember)*)? sp "}"`],
  ["jmember", `jmember ::= jstring sp ":" sp jvalue`],
];
