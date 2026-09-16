// Routes runtime diagnostics to stderr (always) and optionally to an MCP
// logging-notification listener, so clients that support logging can surface
// degradation (e.g. dropped malformed upstream entries) instead of it being
// invisible outside the server process.

type DiagnosticsListener = (message: string) => void;

let listener: DiagnosticsListener | null = null;

export function setDiagnosticsListener(fn: DiagnosticsListener | null): void {
  listener = fn;
}

export function warn(message: string): void {
  console.error(`polvenn: ${message}`);
  listener?.(message);
}
