#!/usr/bin/env node
import { useWebSocketImplementation } from 'nostr-tools/pool';
import WebSocket from 'ws';
import { buildProgram } from './program.js';

// Node < 22 exposes no global WebSocket; nostr-tools needs one to open relay connections.
useWebSocketImplementation(WebSocket);

buildProgram()
  .parseAsync(process.argv)
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
