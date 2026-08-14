// startup.js — The TUI profile's command-line provider: parses the
// `dsh --profile ntui` flag family (--host/--port/--session/--cwd) and its
// --help text, then provides the immutable values as the tuiStartup service.
import { Command } from "commander";
import { parseCmdline } from "@deepseek-ai/dsh-cmdline";

/** Stable Cordis plugin name. */
export const name = "tui-startup";
/** Services required before the flags can be resolved. */
export const inject = ["cmdlineArgs"];
/** Service provided by this ordinary plugin and injected by flag-configured rows. */
export const TUI_STARTUP_SERVICE = "tuiStartup";

function tuiCommand() {
  return new Command()
    .name("dsh --profile ntui")
    .description("Interactive mouse-driven terminal UI for DeepSeek Harness.")
    .helpOption("-h, --help", "show this help")
    .option("--host <host>", "API bind host (default 127.0.0.1)")
    .option("--port <port>", "API listen port; 0 lets the OS pick a free port (default 0)")
    .option("--session <id>", "open this session on start")
    .option("--cwd <path>", "working directory for sessions created from the TUI")
    .option("--attach <url-or-port>", "attach to a RUNNING host instead of booting one (coexists with the web UI; e.g. --attach 3080)")
    .addHelpText("after", `
Examples:
  dsh --profile ntui                          open the TUI on its own host
  dsh --profile ntui --attach 3080            attach to the web UI's host (side-by-side debugging)
  dsh --profile ntui --session <id>           resume one session
  dsh --profile ntui --cwd ~/work             default directory for new sessions
`);
}

export function apply(ctx) {
  const program = tuiCommand();
  program.action(() => {
    const options = program.opts();
    if (options.port !== undefined && !/^\d+$/.test(options.port)) {
      program.error(`error: --port must be a number, got ${JSON.stringify(options.port)}`);
    }
    if (options.host === "0.0.0.0") {
      program.error("error: --host 0.0.0.0 is intentionally not supported: the TUI host exposes remote code execution; use 127.0.0.1");
    }
    ctx.provide(TUI_STARTUP_SERVICE, {
      ...(options.host !== undefined ? { host: options.host } : {}),
      ...(options.port !== undefined ? { port: Number(options.port) } : {}),
      ...(options.session !== undefined ? { session: options.session } : {}),
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.attach !== undefined ? { attach: options.attach } : {}),
    });
  });
  parseCmdline(ctx, program);
}
