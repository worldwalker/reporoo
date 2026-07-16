type LogLevel = "info" | "warn" | "error";
type LogFields = Record<string, unknown>;

function errorFields(error: unknown): LogFields {
  if (error instanceof Error) {
    return {
      errorName: error.name,
      errorMessage: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return { errorMessage: String(error) };
}

function write(level: LogLevel, event: string, fields: LogFields = {}): void {
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...fields,
  });

  if (level === "error") console.error(entry);
  else if (level === "warn") console.warn(entry);
  else console.log(entry);
}

export const logger = {
  info(event: string, fields: LogFields = {}): void {
    write("info", event, fields);
  },

  warn(event: string, fields: LogFields = {}): void {
    write("warn", event, fields);
  },

  error(event: string, error: unknown, fields: LogFields = {}): void {
    write("error", event, { ...fields, ...errorFields(error) });
  },
};
