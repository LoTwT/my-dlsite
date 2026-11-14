#!/usr/bin/env node
import { loginWithBrowser } from "@my-dlsite/browser-auth"
import { runCli } from "./cli.js"

const controller = new AbortController()
const cancel = () => controller.abort()
process.once("SIGINT", cancel)
process.once("SIGTERM", cancel)
try {
  process.exitCode = await runCli(process.argv.slice(2), loginWithBrowser, {
    signal: controller.signal,
  })
} finally {
  process.off("SIGINT", cancel)
  process.off("SIGTERM", cancel)
}
