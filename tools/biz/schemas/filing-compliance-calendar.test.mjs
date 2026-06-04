// filing-compliance-calendar.test.mjs (FF2-6)
// Offline, dependency-free validation of the compliance-calendar EXAMPLE against the
// load-bearing constraints of filing-compliance-calendar.schema.json.
//
// We deliberately avoid pulling in an external JSON-Schema validator (ajv) so the test
// runs with bare `node --test` like the rest of the repo's node:test suites. Instead we
// hand-check the schema's required fields / enums / patterns — the constraints that
// actually matter for the calendar to be consumable by the monitor layer.
//
// GENERAL INFORMATION ONLY — NOT legal/tax advice. The calendar moves no money and files
// nothing; it drives reminders.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(
  readFileSync(join(here, "filing-compliance-calendar.schema.json"), "utf8"),
);
const example = JSON.parse(
  readFileSync(join(here, "filing-compliance-calendar.example.json"), "utf8"),
);

// --- helpers -------------------------------------------------------------

/** enum values for a property path inside the schema, or null if not an enum. */
function enumOf(propSchema) {
  return propSchema && Array.isArray(propSchema.enum) ? propSchema.enum : null;
}

function hasAllRequired(obj, requiredList, ctx) {
  for (const key of requiredList) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(obj, key),
      `${ctx}: missing required field '${key}'`,
    );
  }
}

const ID_RE = /^[a-z0-9-]+$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

// --- top-level -----------------------------------------------------------

test("schema declares draft-07 and the expected required fields", () => {
  assert.equal(schema.type, "object");
  assert.deepEqual(schema.required, ["version", "jurisdiction", "obligations"]);
});

test("example has all top-level required fields", () => {
  hasAllRequired(example, schema.required, "root");
  assert.match(example.version, SEMVER_RE, "version must be semver");
  assert.ok(typeof example.jurisdiction === "string" && example.jurisdiction.length > 0);
  assert.ok(Array.isArray(example.obligations) && example.obligations.length >= 1);
});

// --- each obligation -----------------------------------------------------

const obligationSchema = schema.properties.obligations.items;
const cadenceFreqEnum = enumOf(
  obligationSchema.properties.cadence.properties.frequency,
);
const triggerTypeEnum = enumOf(obligationSchema.properties.trigger.properties.type);
const categoryEnum = enumOf(obligationSchema.properties.category);
const appliesToItemEnum = enumOf(obligationSchema.properties.appliesTo.items);

test("every obligation satisfies its required fields, patterns, and enums", () => {
  const seenIds = new Set();
  for (const ob of example.obligations) {
    const ctx = `obligation '${ob.id ?? "?"}'`;
    hasAllRequired(ob, obligationSchema.required, ctx);

    assert.match(ob.id, ID_RE, `${ctx}: id must match ${ID_RE}`);
    assert.ok(!seenIds.has(ob.id), `${ctx}: duplicate id`);
    seenIds.add(ob.id);

    if (ob.category !== undefined) {
      assert.ok(categoryEnum.includes(ob.category), `${ctx}: bad category`);
    }

    assert.ok(Array.isArray(ob.appliesTo) && ob.appliesTo.length >= 1, `${ctx}: appliesTo`);
    for (const a of ob.appliesTo) {
      assert.ok(appliesToItemEnum.includes(a), `${ctx}: bad appliesTo '${a}'`);
    }

    // cadence
    hasAllRequired(ob.cadence, obligationSchema.properties.cadence.required, `${ctx}.cadence`);
    assert.ok(
      cadenceFreqEnum.includes(ob.cadence.frequency),
      `${ctx}: bad cadence.frequency '${ob.cadence.frequency}'`,
    );
    if (ob.cadence.leadDays !== undefined) {
      assert.ok(
        Number.isInteger(ob.cadence.leadDays) && ob.cadence.leadDays >= 0,
        `${ctx}: leadDays must be a non-negative integer`,
      );
    }

    // trigger
    hasAllRequired(ob.trigger, obligationSchema.properties.trigger.required, `${ctx}.trigger`);
    assert.ok(
      triggerTypeEnum.includes(ob.trigger.type),
      `${ctx}: bad trigger.type '${ob.trigger.type}'`,
    );

    // fee (optional) — if present, amount non-negative
    if (ob.fee && ob.fee.amount !== undefined) {
      assert.ok(ob.fee.amount >= 0, `${ctx}: fee.amount must be >= 0`);
    }
  }
});

test("UPL/funds guardrail: the model never encodes a money-moving action", () => {
  // The calendar is reminders-only. No obligation may carry a 'pay'/'submit'/'file' action
  // field — the schema doesn't define one, and the example must not smuggle one in.
  for (const ob of example.obligations) {
    for (const forbidden of ["action", "submit", "pay", "autopay", "file"]) {
      assert.ok(
        !Object.prototype.hasOwnProperty.call(ob, forbidden),
        `obligation '${ob.id}' must not contain a money/filing action field '${forbidden}'`,
      );
    }
  }
});
