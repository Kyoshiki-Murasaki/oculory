'use strict';

const fs = require('node:fs');
const moduleApi = require('node:module');
const path = require('node:path');
const net = require('node:net');
const tls = require('node:tls');
const http = require('node:http');
const https = require('node:https');
const http2 = require('node:http2');
const dns = require('node:dns');
const dgram = require('node:dgram');

const guardCode = 'OCULORY_NODE_NETWORK_DENIED';

function denied() {
  const error = new Error('outbound Node network access is disabled for the Oculory package demo');
  error.code = guardCode;
  throw error;
}

function unixEndpoint(args) {
  const first = args[0];
  if (Array.isArray(first)) return unixEndpoint(first);
  if (typeof first === 'string') return first.length > 0;
  if (first !== null && typeof first === 'object' && !Array.isArray(first)) {
    return typeof first.path === 'string' && first.path.length > 0;
  }
  return false;
}

const socketConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedSocketConnect(...args) {
  if (!unixEndpoint(args)) return denied();
  return socketConnect.apply(this, args);
};

const createConnection = net.createConnection;
function guardedCreateConnection(...args) {
  if (!unixEndpoint(args)) return denied();
  return createConnection.apply(this, args);
}
net.createConnection = guardedCreateConnection;
net.connect = guardedCreateConnection;

const serverListen = net.Server.prototype.listen;
net.Server.prototype.listen = function guardedServerListen(...args) {
  if (!unixEndpoint(args)) return denied();
  return serverListen.apply(this, args);
};

tls.connect = denied;
http.request = denied;
http.get = denied;
https.request = denied;
https.get = denied;
http2.connect = denied;
dgram.createSocket = denied;

for (const name of [
  'lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname',
  'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv',
  'resolveTxt', 'reverse',
]) {
  if (typeof dns[name] === 'function') dns[name] = denied;
  if (typeof dns.promises?.[name] === 'function') dns.promises[name] = async () => denied();
}

globalThis.fetch = async () => denied();
if (typeof globalThis.WebSocket === 'function') {
  globalThis.WebSocket = class NetworkDeniedWebSocket {
    constructor() {
      denied();
    }
  };
}

globalThis[Symbol.for('oculory.node-network-denied')] = true;
moduleApi.syncBuiltinESMExports();

const proofPath = process.env.OCULORY_NETWORK_GUARD_PROOF;
if (proofPath) {
  const role = path.basename(process.argv[1] || 'node');
  fs.appendFileSync(proofPath, `${process.pid}:${role}\n`, { encoding: 'utf8', flag: 'a', mode: 0o600 });
}
