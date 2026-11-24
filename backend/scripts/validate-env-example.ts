#!/usr/bin/env tsx
/**
 * CI check to validate that .env.example documents every key in the config schema
 * and that every key in .env.example exists in the schema.
 *
 * This prevents drift between the configuration schema and documentation.
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { envSchema } from "../src/config";

// Extract all keys from the Zod schema
const schemaKeys = new Set(
  Object.keys(envSchema.shape).filter((key) => !key.startsWith("_"))
);

// Parse .env.example to extract keys
const envExamplePath = resolve(__dirname, "../.env.example");
const envExampleContent = readFileSync(envExamplePath, "utf-8");

const envExampleKeys = new Set<string>();
const lines = envExampleContent.split("\n");

for (const line of lines) {
  const trimmed = line.trim();
  // Match lines like KEY=value or KEY= (with or without comment)
  const match = trimmed.match(/^([A-Z_][A-Z0-9_]*)=/);
  if (match) {
    envExampleKeys.add(match[1]);
  }
}

// Find keys in schema but not in .env.example
const missingInExample = [...schemaKeys].filter((key) => !envExampleKeys.has(key));

// Find keys in .env.example but not in schema
const extraInExample = [...envExampleKeys].filter((key) => !schemaKeys.has(key));

if (missingInExample.length > 0 || extraInExample.length > 0) {
  console.error("❌ .env.example does not match config schema:");
  
  if (missingInExample.length > 0) {
    console.error("\nKeys in schema but missing from .env.example:");
    missingInExample.forEach((key) => console.error(`  - ${key}`));
  }
  
  if (extraInExample.length > 0) {
    console.error("\nKeys in .env.example but not in schema:");
    extraInExample.forEach((key) => console.error(`  - ${key}`));
  }
  
  process.exit(1);
}

console.log("✅ .env.example matches config schema");
process.exit(0);
