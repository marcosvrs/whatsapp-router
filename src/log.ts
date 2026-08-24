export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function parseLogLevel(value: string | undefined): LogLevel {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "debug" || normalized === "info" || normalized === "warn" || normalized === "error") {
    return normalized;
  }
  return "info";
}

let minimumLevel: LogLevel = parseLogLevel(process.env.LOG_LEVEL);

function write(level: LogLevel, ...args: unknown[]): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[minimumLevel]) return;
  console.log(`${new Date().toISOString()} [${level.toUpperCase()}]`, ...args);
}

export function setLogLevel(level: LogLevel): void {
  minimumLevel = level;
}

export function getLogLevel(): LogLevel {
  return minimumLevel;
}

export function debug(...args: unknown[]): void {
  write("debug", ...args);
}

export function info(...args: unknown[]): void {
  write("info", ...args);
}

export function warn(...args: unknown[]): void {
  write("warn", ...args);
}

export function error(...args: unknown[]): void {
  write("error", ...args);
}
