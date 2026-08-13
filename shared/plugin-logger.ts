type LogLevel = "debug" | "info" | "warn" | "error"

interface AppLogClient {
  app: {
    log(input: {
      body: {
        service: string
        level: LogLevel
        message: string
        extra?: Record<string, unknown>
      }
    }): Promise<unknown>
  }
}

interface Logger {
  debug(message: string, extra?: Record<string, unknown>): void
  info(message: string, extra?: Record<string, unknown>): void
  warn(message: string, extra?: Record<string, unknown>): void
  error(message: string, extra?: Record<string, unknown>): void
}

export function createLogger(client: AppLogClient, service: string): Logger {
  const log = (level: LogLevel, message: string, extra?: Record<string, unknown>): void => {
    try {
      void client.app.log({
        body: { service, level, message, extra },
      })
    } catch {
      // logging must never break plugin behavior
    }
  }
  return {
    debug: (m, e) => log("debug", m, e),
    info: (m, e) => log("info", m, e),
    warn: (m, e) => log("warn", m, e),
    error: (m, e) => log("error", m, e),
  }
}

export type PluginLogger = Logger
