'use strict';
const http = require('node:http');

const port = Number(process.env.PORT || '8080');
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  process.exit(1);
}

const deadline = setTimeout(() => process.exit(1), 8000);
const request = http.get(
  { hostname: '127.0.0.1', port, path: '/health/ready', timeout: 4000 },
  (response) => {
    response.resume();
    clearTimeout(deadline);
    process.exit(response.statusCode === 200 ? 0 : 1);
  },
);
request.on('timeout', () => request.destroy());
request.on('error', () => {
  clearTimeout(deadline);
  process.exit(1);
});
