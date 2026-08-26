require('dotenv').config();

// Legacy entrypoint: the official runner owns manifest validation, historical
// aliases, deterministic ordering and the advisory lock.
require('./run-migrations.js');
