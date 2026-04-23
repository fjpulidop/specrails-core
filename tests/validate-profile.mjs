#!/usr/bin/env node
// Validate a profile JSON file against a given JSON Schema using ajv.
// Usage: node validate-profile.mjs <schema-path> <profile-path>
// Exits 0 on pass, 1 on fail. Prints error summary on fail.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import Ajv from 'ajv';

const [, , schemaPath, profilePath] = process.argv;

if (!schemaPath || !profilePath) {
  console.error('Usage: validate-profile.mjs <schema-path> <profile-path>');
  process.exit(2);
}

const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
const profile = JSON.parse(readFileSync(profilePath, 'utf8'));

const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

if (!validate(profile)) {
  const errors = (validate.errors || [])
    .map((e) => `  ${e.instancePath || '/'} ${e.message} (${JSON.stringify(e.params)})`)
    .join('\n');
  console.error(`Profile validation failed:\n${errors}`);
  process.exit(1);
}

process.exit(0);
