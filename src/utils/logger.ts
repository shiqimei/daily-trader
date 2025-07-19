import pino from 'pino'

const isProduction = process.env.NODE_ENV === 'production'

export const logger = pino({
  level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
  transport: isProduction
    ? undefined
    : {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname'
        }
      },
  formatters: {
    level: label => {
      return { level: label.toUpperCase() }
    }
  },
  timestamp: pino.stdTimeFunctions.isoTime
})

export const createLogger = (name: string) => {
  return logger.child({ module: name })
}
