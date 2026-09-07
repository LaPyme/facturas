#!/usr/bin/env node
import { main } from "../dist/cli.mjs";

await main(process.argv.slice(2));
