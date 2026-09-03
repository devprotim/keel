import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { MESSAGE_AWARENESS, MESSAGE_SYNC } from './protocol.ts';
import type { Room, Socket } from './room.ts';

/**
 * A real Yjs peer wired directly to a Room, with no network in between.
 *
 * This is deliberately a full protocol implementation rather than a mock. The
 * interesting failures in collaborative editing are protocol failures, and a
 * mock that returns canned frames would pass while the real handshake was
 * broken. Removing the socket removes the flakiness, not the logic.
 */
export class TestClient {
  readonly doc = new Y.Doc();
  readonly awareness: awarenessProtocol.Awareness;
  readonly socket: Socket;

  readonly #room: Room;
  #open = true;

  /**
   * Attach a new client to a room and complete the handshake in both directions.
   *
   * Both peers must open with a sync step 1. The server sends its own so the
   * client can catch up on anything it missed, and the client sends one so the
   * server knows to hand over the existing document. Sending only one of the two
   * is a silent failure: the connection looks healthy and the late joiner simply
   * sees an empty diagram.
   */
  static connect(room: Room): TestClient {
    const client = new TestClient(room);
    room.addConnection(client.socket);
    client.requestSync();
    return client;
  }

  constructor(room: Room) {
    this.#room = room;
    this.awareness = new awarenessProtocol.Awareness(this.doc);

    // `self` rather than `this`: the getter below lives in an object literal, so
    // its own `this` is the socket, not the client. Private-field access is
    // lexically scoped to the class body, so `self.#open` is still legal here.
    const self = this;
    this.socket = {
      send: (data) => this.#receive(data),
      close: () => {
        self.#open = false;
      },
      get open() {
        return self.#open;
      },
    };

    this.doc.on('update', this.#onLocalUpdate);
    this.awareness.on('update', this.#onLocalAwareness);
  }

  get nodes(): Y.Map<unknown> {
    return this.doc.getMap('nodes');
  }

  /** Everyone else's presence, as this client currently sees it. */
  peerStates(): Map<number, Record<string, unknown>> {
    const states = new Map<number, Record<string, unknown>>();
    for (const [clientId, state] of this.awareness.getStates()) {
      if (clientId === this.doc.clientID) continue;
      states.set(clientId, state as Record<string, unknown>);
    }
    return states;
  }

  /** Send our state vector so the server replies with whatever we are missing. */
  requestSync(): void {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, this.doc);
    this.#room.handleMessage(this.socket, encoding.toUint8Array(encoder));
  }

  disconnect(): void {
    this.#open = false;
    this.doc.off('update', this.#onLocalUpdate);
    this.awareness.off('update', this.#onLocalAwareness);
    this.#room.removeConnection(this.socket);
  }

  /** Server to client. */
  #receive(data: Uint8Array): void {
    if (!this.#open) return;

    const decoder = decoding.createDecoder(data);
    const messageType = decoding.readVarUint(decoder);

    if (messageType === MESSAGE_SYNC) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.readSyncMessage(decoder, encoder, this.doc, REMOTE);
      if (encoding.length(encoder) > 1) {
        this.#room.handleMessage(this.socket, encoding.toUint8Array(encoder));
      }
    } else if (messageType === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(
        this.awareness,
        decoding.readVarUint8Array(decoder),
        REMOTE,
      );
    }
  }

  /** Client to server. Updates that came from the server are not echoed back. */
  readonly #onLocalUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === REMOTE || !this.#open) return;

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    this.#room.handleMessage(this.socket, encoding.toUint8Array(encoder));
  };

  readonly #onLocalAwareness = (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    if (origin === REMOTE || !this.#open) return;

    const changed = [...changes.added, ...changes.updated, ...changes.removed];
    if (changed.length === 0) return;

    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed),
    );
    this.#room.handleMessage(this.socket, encoding.toUint8Array(encoder));
  };
}

/** Marks state that arrived from the server, so it is not sent straight back. */
const REMOTE = Symbol('test:remote');
