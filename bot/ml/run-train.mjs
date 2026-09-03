#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePython, TRAIN_PY } from "../predictfun/ml.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const py = resolvePython();
const child = spawn(py, [TRAIN_PY], { cwd: root, stdio: "inherit", env: process.env });
child.on("exit", (code) => process.exit(code ?? 1));
