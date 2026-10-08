const ts = () => new Date().toISOString();
const fmt = (lvl, scope, msg) => `${ts()} ${lvl} [${scope}] ${msg}`;

module.exports = {
  info: (scope, msg) => console.log(fmt('INFO ', scope, msg)),
  warn: (scope, msg) => console.warn(fmt('WARN ', scope, msg)),
  error: (scope, msg) => console.error(fmt('ERROR', scope, msg)),
};
