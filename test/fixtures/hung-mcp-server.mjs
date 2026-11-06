#!/usr/bin/env node
// A server that accepts the spawn but never answers `initialize`. Used to prove
// that McpToolSource's listing cap keeps the first Worker turn moving.
setInterval(() => {}, 1 << 30)
