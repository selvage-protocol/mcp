/**
 * The JSON Schema subset a tool's `inputSchema` is written in, and the validation of one
 * `tools/call` argument set against it.
 *
 * `2025-11-25/server/tools.mdx` requires the root to be a valid JSON Schema object of
 * `type: "object"` and says nothing about which keywords a server must honor; the v1 client does
 * not validate `arguments` at all, so this is the only check a call gets. That makes an
 * unvalidated keyword worse than an unsupported one: a tool whose schema says `oneOf` and whose
 * arguments pass every call would be reporting a guarantee nothing checked.
 *
 * So the keywords are exactly the list below, and a schema that uses any other one is refused
 * when it is registered and again when the tool is called, loudly, rather than silently skipped.
 * The list is what this repository's tools need; a tool that needs more of 2020-12 extends this
 * file, and the refusal is what says so.
 */

/** A JSON Schema, as far as this server understands one. */
export interface JsonSchema {
  readonly $schema?: string;
  readonly title?: string;
  readonly description?: string;
  readonly type?: JsonSchemaType | readonly JsonSchemaType[];
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | JsonSchema;
  readonly items?: JsonSchema;
  readonly enum?: readonly unknown[];
}

export type JsonSchemaType =
  | 'object'
  | 'array'
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'null';

const TYPES: readonly JsonSchemaType[] = [
  'object',
  'array',
  'string',
  'number',
  'integer',
  'boolean',
  'null',
];

const KEYWORDS = [
  '$schema',
  'title',
  'description',
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
] as const;

/** A schema this server will not register or validate against, naming what is wrong with it. */
export class SchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isType(value: unknown): value is JsonSchemaType {
  return typeof value === 'string' && (TYPES as readonly string[]).includes(value);
}

/** The types a schema admits, as a list, with a bare `type` read as a list of one. */
function typesOf(schema: JsonSchema): readonly JsonSchemaType[] {
  const type = schema.type;
  if (type === undefined) {
    return [];
  }
  return typeof type === 'string' ? [type] : type;
}

/**
 * Checks a schema before it is registered, and throws `SchemaError` naming the keyword, the
 * position and the reason.
 *
 * A subschema is held to the same list as the root, and `properties`, `required` and
 * `additionalProperties` are only meaningful where `type` names an object, `items` only where it
 * names an array — a schema that says otherwise would describe a value this validator never
 * looks into, which is the failure this whole file exists to prevent.
 */
function checkSchema(schema: unknown, at: string): asserts schema is JsonSchema {
  const where = at === '' ? 'the schema' : at;
  if (!isRecord(schema)) {
    throw new SchemaError(`${where} is not a JSON object`);
  }
  for (const key of Object.keys(schema)) {
    if (!(KEYWORDS as readonly string[]).includes(key)) {
      throw new SchemaError(`${where} uses "${key}", which this server does not validate`);
    }
  }
  const type = schema['type'];
  if (type !== undefined) {
    const listed = Array.isArray(type) ? type : [type];
    if (listed.length === 0) {
      throw new SchemaError(`${where} has an empty "type"`);
    }
    for (const one of listed) {
      if (!isType(one)) {
        throw new SchemaError(`${where} has a "type" that is not a JSON Schema type: ${JSON.stringify(one)}`);
      }
    }
  }
  const types: readonly JsonSchemaType[] =
    type === undefined ? [] : Array.isArray(type) ? type : [type];

  const properties = schema['properties'];
  const required = schema['required'];
  const additional = schema['additionalProperties'];
  const items = schema['items'];
  const names = schema['enum'];

  if (properties !== undefined || required !== undefined || additional !== undefined) {
    if (!types.includes('object')) {
      throw new SchemaError(`${where} has object keywords but no "type": "object"`);
    }
  }
  if (items !== undefined && !types.includes('array')) {
    throw new SchemaError(`${where} has "items" but no "type": "array"`);
  }
  if (properties !== undefined) {
    if (!isRecord(properties)) {
      throw new SchemaError(`${where} has a "properties" that is not an object`);
    }
    for (const [name, sub] of Object.entries(properties)) {
      checkSchema(sub, at === '' ? name : `${at}.${name}`);
    }
  }
  if (required !== undefined) {
    if (!Array.isArray(required) || required.some((name) => typeof name !== 'string')) {
      throw new SchemaError(`${where} has a "required" that is not an array of names`);
    }
  }
  if (additional !== undefined && typeof additional !== 'boolean') {
    checkSchema(additional, `${where}.additionalProperties`);
  }
  if (items !== undefined) {
    checkSchema(items, `${where}.items`);
  }
  if (names !== undefined && (!Array.isArray(names) || names.length === 0)) {
    throw new SchemaError(`${where} has an "enum" that is not a non-empty array`);
  }
}

/**
 * Checks a tool's advertised `inputSchema`: the keywords above, and the root an object, which
 * the specification requires of every tool — "Tool arguments are always JSON objects".
 */
export function checkInputSchema(schema: unknown): asserts schema is JsonSchema {
  checkSchema(schema, '');
  if (!typesOf(schema).includes('object')) {
    throw new SchemaError('an inputSchema root must be "type": "object"');
  }
}

/** What one value is, for an error message. */
function describe(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'an array';
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'an integer' : 'a number';
  }
  switch (typeof value) {
    case 'object':
      return 'an object';
    case 'string':
      return 'a string';
    case 'boolean':
      return 'a boolean';
    default:
      return typeof value;
  }
}

function matchesType(value: unknown, type: JsonSchemaType): boolean {
  switch (type) {
    case 'object':
      return isRecord(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number';
    case 'null':
      return value === null;
  }
}

/** Structural equality, which is what `enum` compares by. */
function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => sameValue(item, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const names = Object.keys(left);
    return (
      names.length === Object.keys(right).length &&
      names.every((name) => Object.hasOwn(right, name) && sameValue(left[name], right[name]))
    );
  }
  return false;
}

function join(at: string, name: string): string {
  return at === '' ? name : `${at}.${name}`;
}

/** Every way `value` fails `schema`, in the order the schema names them. Empty means it passes. */
export function validate(value: unknown, schema: JsonSchema, at = ''): string[] {
  const where = at === '' ? 'arguments' : at;
  const problems: string[] = [];

  if (schema.enum !== undefined && !schema.enum.some((member) => sameValue(member, value))) {
    problems.push(`${where}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
    return problems;
  }

  const types = typesOf(schema);
  if (types.length > 0 && !types.some((type) => matchesType(value, type))) {
    problems.push(`${where}: expected ${types.join(' or ')}, got ${describe(value)}`);
    return problems;
  }

  if (isRecord(value) && types.includes('object')) {
    const properties = schema.properties ?? {};
    for (const name of schema.required ?? []) {
      if (!Object.hasOwn(value, name)) {
        problems.push(`${join(at, name)}: required property is missing`);
      }
    }
    // A name that is not an own property of `properties` is not declared, even when it is one
    // `Object.prototype` answers to: `constructor`, `toString` and `__proto__` are ordinary
    // argument names, and reading them off the prototype would take each as its declared name.
    for (const [name, item] of Object.entries(value)) {
      const sub = Object.hasOwn(properties, name) ? properties[name] : undefined;
      if (sub !== undefined) {
        problems.push(...validate(item, sub, join(at, name)));
        continue;
      }
      const additional = schema.additionalProperties;
      if (additional === false) {
        problems.push(`${join(at, name)}: unknown property`);
      } else if (isRecord(additional)) {
        problems.push(...validate(item, additional, join(at, name)));
      }
    }
  }

  if (Array.isArray(value) && types.includes('array') && schema.items !== undefined) {
    value.forEach((item, index) => {
      problems.push(...validate(item, schema.items as JsonSchema, join(at, String(index))));
    });
  }

  return problems;
}
