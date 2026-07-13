function write(level, message, fields = {}) {
  const entry = {
    time: new Date().toISOString(),
    level,
    message,
    ...fields,
  };
  const output = JSON.stringify(entry);
  if (level === 'error') console.error(output);
  else if (level === 'warn') console.warn(output);
  else console.log(output);
}

export const logger = {
  info(message, fields) {
    write('info', message, fields);
  },
  warn(message, fields) {
    write('warn', message, fields);
  },
  error(message, fields) {
    write('error', message, fields);
  },
};
