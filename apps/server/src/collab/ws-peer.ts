import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { MESSAGE_SYNC } from './protocol.ts';

/** The subset of `ws` a peer needs; `app.injectWS` returns one. */
interface WsLike {
  send(data: Uint8Array): void;
  on(event: 'message', listener: (data: Buffer) => void): void;
  on(event: 'close', listener: (code: number) => void): void;
  close(): void;
}

const REMOTE = Symbol('remote');

/**
 * A real Yjs peer over a real socket to the app, for tests that need the
 * socket route itself (authorisation, read-only enforcement) rather than a
 * Room in isolation, which TestClient covers without a network.
 */
export class WsPeer {
  readonly doc = new Y.Doc();
  readonly ws: WsLike;
  readonly closed: Promise<number>;
  readonly synced: Promise<void>;

  constructor(ws: WsLike) {
    this.ws = ws;
    let markSynced: () => void = () => undefined;
    this.synced = new Promise((resolve) => (markSynced = resolve));
    this.closed = new Promise((resolve) => ws.on('close', (code: number) => resolve(code)));

    ws.on('message', (data: Buffer) => {
      const decoder = decoding.createDecoder(new Uint8Array(data));
      if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      const type = syncProtocol.readSyncMessage(decoder, encoder, this.doc, REMOTE);
      if (encoding.length(encoder) > 1) ws.send(encoding.toUint8Array(encoder));
      if (type === syncProtocol.messageYjsSyncStep2) markSynced();
    });

    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === REMOTE) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      ws.send(encoding.toUint8Array(encoder));
    });

    const hello = encoding.createEncoder();
    encoding.writeVarUint(hello, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(hello, this.doc);
    ws.send(encoding.toUint8Array(hello));
  }

  get nodes(): Y.Map<unknown> {
    return this.doc.getMap('nodes');
  }
}
