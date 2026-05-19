const jhaConfig = require('eslint-config-jha-react-node/node');

const config = [
  {ignores: ['**/.expo/', 'tmp/', 'projects/justin-sdk/']},
  ...jhaConfig,
];

module.exports = config;
