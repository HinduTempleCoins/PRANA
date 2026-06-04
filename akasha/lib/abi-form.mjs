/**
 * abi-form.mjs — Q5 + Z2
 *
 * The ABI-driven call-UI GENERATOR (headless).
 *
 * Given an ethers `Interface` (or a raw ABI array, or a single fragment) this
 * module produces a *form model* the React shell can render with zero ABI
 * knowledge of its own, plus an `execute()` that coerces the string/JS values a
 * form collects into the exact types ethers wants and dispatches read-vs-write
 * (staticCall for view/pure, send for state-changing).
 *
 * Form model for one function:
 *   {
 *     name, signature, selector,
 *     stateMutability: 'view'|'pure'|'nonpayable'|'payable',
 *     readonly: boolean,            // true for view/pure (use staticCall)
 *     payable:  boolean,
 *     inputs:  [ FieldModel, ... ],
 *     outputs: [ OutputModel, ... ],
 *   }
 *
 * FieldModel:
 *   { name, type, baseType, component, placeholder, isArray, validate(raw)->{ok,error?} }
 *
 * `component` is the UI hint the shell maps to a widget:
 *   'address' | 'bool' | 'number' | 'bytes' | 'text'
 *
 * Coercion (coerceValue) turns a raw form value into the JS value ethers v6
 * expects for the abi type:
 *   uint* / int*   -> BigInt (accepts decimal or 0x string, number, bigint)
 *   address      -> EIP-55 checksummed string
 *   bool         -> boolean  (accepts true/false, "true"/"false", 1/0)
 *   bytes/bytesN -> 0x-hex string (validated length for fixed bytesN)
 *   string       -> string as-is
 *   tuple/array  -> recursively coerced (array values may be passed as JS arrays
 *                   or JSON strings)
 *
 * Nothing here touches a key or a network by itself — `execute` takes an ethers
 * Contract (already wired to a provider/signer) the caller supplies.
 */

import { Interface, ParamType, getAddress, isAddress } from 'ethers';

// ---- component classification ----------------------------------------------

/** Map an ethers ParamType to a UI component hint. */
function componentFor(paramType) {
  const base = paramType.baseType;
  if (base === 'address') return 'address';
  if (base === 'bool') return 'bool';
  if (base === 'string') return 'text';
  if (base === 'array' || base === 'tuple') return 'text'; // JSON-entry in the UI
  if (typeof base === 'string') {
    if (base.startsWith('uint') || base.startsWith('int')) return 'number';
    if (base === 'bytes' || /^bytes\d+$/.test(base)) return 'bytes';
  }
  return 'text';
}

/** A human placeholder for a field. */
function placeholderFor(paramType) {
  const t = paramType.type;
  switch (componentFor(paramType)) {
    case 'address':
      return '0x… (20-byte address)';
    case 'bool':
      return 'true / false';
    case 'number':
      return t.endsWith('[]') ? `[${paramType.baseType}, …]` : `integer (${paramType.baseType})`;
    case 'bytes':
      return paramType.baseType === 'bytes' ? '0x… (hex bytes)' : `0x… (${paramType.baseType})`;
    default:
      return paramType.type;
  }
}

// ---- coercion ---------------------------------------------------------------

const HEX_RE = /^0x[0-9a-fA-F]*$/;

/** Coerce a single raw form value to the JS value ethers wants for `paramType`. */
export function coerceValue(paramType, raw) {
  const base = paramType.baseType;

  // arrays: accept a JS array or a JSON string; coerce each element
  if (base === 'array') {
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(arr)) throw new Error(`${paramType.type}: expected an array`);
    const child = paramType.arrayChildren;
    return arr.map((el) => coerceValue(child, el));
  }

  // tuples: accept a JS array, JS object (by component name), or JSON string
  if (base === 'tuple') {
    let obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const comps = paramType.components;
    if (Array.isArray(obj)) {
      return obj.map((el, i) => coerceValue(comps[i], el));
    }
    if (obj && typeof obj === 'object') {
      return comps.map((c) => coerceValue(c, obj[c.name]));
    }
    throw new Error(`${paramType.type}: expected an object or array for a tuple`);
  }

  if (base === 'address') {
    if (typeof raw !== 'string' || !isAddress(raw)) {
      throw new Error(`invalid address: ${JSON.stringify(raw)}`);
    }
    return getAddress(raw);
  }

  if (base === 'bool') {
    if (typeof raw === 'boolean') return raw;
    if (raw === 'true' || raw === 1 || raw === '1') return true;
    if (raw === 'false' || raw === 0 || raw === '0') return false;
    throw new Error(`invalid bool: ${JSON.stringify(raw)}`);
  }

  if (typeof base === 'string' && (base.startsWith('uint') || base.startsWith('int'))) {
    if (typeof raw === 'bigint') return raw;
    if (typeof raw === 'number') {
      if (!Number.isInteger(raw)) throw new Error(`${base}: ${raw} is not an integer`);
      return BigInt(raw);
    }
    if (typeof raw === 'string') {
      const s = raw.trim();
      if (s === '') throw new Error(`${base}: empty value`);
      return BigInt(s); // handles 0x and decimal; throws on garbage
    }
    throw new Error(`${base}: cannot coerce ${typeof raw}`);
  }

  if (base === 'bytes' || /^bytes\d+$/.test(base)) {
    if (typeof raw !== 'string' || !HEX_RE.test(raw)) {
      throw new Error(`${base}: expected a 0x-hex string`);
    }
    const m = /^bytes(\d+)$/.exec(base);
    if (m) {
      const want = Number(m[1]) * 2 + 2; // 0x + 2 hex chars/byte
      if (raw.length !== want) {
        throw new Error(`${base}: expected exactly ${m[1]} bytes (${want - 2} hex chars)`);
      }
    } else if (raw.length % 2 !== 0) {
      throw new Error('bytes: hex string must have an even number of nibbles');
    }
    return raw;
  }

  // string and anything else: pass through (ethers will reject true garbage)
  return raw;
}

/** Build a validate(raw)->{ok,error?} closure for a param. Never throws. */
function makeValidator(paramType) {
  return (raw) => {
    try {
      coerceValue(paramType, raw);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err?.message ?? String(err) };
    }
  };
}

// ---- model generation -------------------------------------------------------

function fieldModel(paramType, index) {
  return {
    name: paramType.name || `arg${index}`,
    type: paramType.type,
    baseType: paramType.baseType,
    isArray: paramType.baseType === 'array',
    component: componentFor(paramType),
    placeholder: placeholderFor(paramType),
    validate: makeValidator(paramType),
  };
}

function outputModel(paramType, index) {
  return {
    name: paramType.name || `out${index}`,
    type: paramType.type,
    baseType: paramType.baseType,
    component: componentFor(paramType),
  };
}

/** Coerce the input to an ethers Interface. */
export function toInterface(abiOrIface) {
  if (abiOrIface instanceof Interface) return abiOrIface;
  if (Array.isArray(abiOrIface)) return new Interface(abiOrIface);
  // a Hardhat artifact { abi: [...] }
  if (abiOrIface && Array.isArray(abiOrIface.abi)) return new Interface(abiOrIface.abi);
  // a single fragment object or human-readable string
  return new Interface([abiOrIface]);
}

/**
 * Build a form model for ONE function fragment (by name or FunctionFragment).
 * @param {Interface|any[]|object} abiOrIface
 * @param {string} fnName  function name (or full signature for overloads)
 * @returns {object} form model
 */
export function formModelForFunction(abiOrIface, fnName) {
  const iface = toInterface(abiOrIface);
  const fn = iface.getFunction(fnName);
  if (!fn) throw new Error(`abi-form: no function ${fnName}`);
  const readonly = fn.stateMutability === 'view' || fn.stateMutability === 'pure';
  return {
    name: fn.name,
    signature: fn.format('sighash'),
    selector: fn.selector,
    stateMutability: fn.stateMutability,
    readonly,
    payable: fn.stateMutability === 'payable',
    inputs: fn.inputs.map(fieldModel),
    outputs: fn.outputs.map(outputModel),
  };
}

/**
 * Build form models for every function in an ABI/Interface.
 * @returns {object[]} one model per function (sorted: reads first, then writes,
 *          alphabetical within each group — a sensible default UI order).
 */
export function formModels(abiOrIface) {
  const iface = toInterface(abiOrIface);
  const models = [];
  iface.forEachFunction((fn) => {
    models.push(formModelForFunction(iface, fn.format('sighash')));
  });
  models.sort((a, b) => {
    if (a.readonly !== b.readonly) return a.readonly ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return models;
}

// ---- execution --------------------------------------------------------------

/**
 * Coerce a map/array of raw form values into the ordered arg array ethers wants.
 * `values` may be an object keyed by input name, or an array in input order.
 * @param {object} model  a function form model (from formModelForFunction)
 * @param {object|any[]} values
 * @returns {any[]}
 */
export function coerceArgs(model, values) {
  const list = model.inputs;
  return list.map((field, i) => {
    const raw = Array.isArray(values) ? values[i] : values?.[field.name];
    // re-derive the ParamType so coerceValue handles arrays/tuples correctly
    return coerceValueByType(field.type, raw);
  });
}

// coerce by a type string by round-tripping through a throwaway ParamType.
function coerceValueByType(typeStr, raw) {
  return coerceValue(ParamType.from(typeStr), raw);
}

/**
 * Execute a function against an ethers Contract with input coercion + read/write
 * dispatch. Reads use staticCall (no tx); writes send a tx (returns the tx
 * response, which the caller can `.wait()` on).
 *
 * @param {import('ethers').Contract} contract  wired to a provider (reads) or signer (writes)
 * @param {string} fnName
 * @param {object|any[]} values  raw form values (by name or in order)
 * @param {object} [opts]
 * @param {object} [opts.overrides]  ethers call/tx overrides ({ value, gasLimit, … })
 * @param {Interface|any[]|object} [opts.abi]  ABI to build the model from (defaults to contract.interface)
 * @returns {Promise<any>} decoded return value(s) for reads; a TransactionResponse for writes
 */
export async function execute(contract, fnName, values, opts = {}) {
  if (!contract || typeof contract.getFunction !== 'function') {
    throw new Error('execute: an ethers Contract is required');
  }
  const iface = opts.abi ? toInterface(opts.abi) : contract.interface;
  const model = formModelForFunction(iface, fnName);
  const args = coerceArgs(model, values);

  const overrides = opts.overrides ? [opts.overrides] : [];
  const method = contract.getFunction(model.signature);

  if (model.readonly) {
    // staticCall never sends a tx, even if the contract has a signer.
    return method.staticCall(...args, ...overrides);
  }
  // state-changing: send a transaction (needs a signer-connected contract).
  return method(...args, ...overrides);
}

export default {
  formModels,
  formModelForFunction,
  coerceValue,
  coerceArgs,
  execute,
  toInterface,
};
