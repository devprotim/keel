import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import type * as Y from 'yjs';

/**
 * Wire protocol, matching the y-websocket framing so any standard Yjs client can
 * talk to this server.
 *
 * Every frame is a binary message whose first varUint is the channel. Keeping the
 * two channels in one socket matters: presence and document updates must arrive
 * in the order they were produced, and two sockets would not guarantee that.
 */
export const MESSAGE_SYNC = 0;
export const MESSAGE_AWARENESS = 1;

/**
 * The opening frame of a session: "here is what I already have, send me the rest."
 *
 * Yjs sync is a three-step handshake. Step 1 carries the sender's state vector,
 * step 2 carries the delta the receiver was missing. Both peers run it in both
 * directions, which is how a reconnecting client that edited while offline gets
 * merged instead of overwritten.
 */
export function encodeSyncStep1(doc: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(encoder, doc);
  return encoding.toUint8Array(encoder);
}

/** The full document state, for a peer that has just told us what it is missing. */
export function encodeSyncStep2(doc: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep2(encoder, doc);
  return encoding.toUint8Array(encoder);
}

/** Wrap a raw Yjs update for broadcast. */
export function encodeUpdate(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeUpdate(encoder, update);
  return encoding.toUint8Array(encoder);
}

/** Wrap presence state for the given clients. */
export function encodeAwareness(
  awareness: awarenessProtocol.Awareness,
  clients: number[],
): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(
    encoder,
    awarenessProtocol.encodeAwarenessUpdate(awareness, clients),
  );
  return encoding.toUint8Array(encoder);
}

export type DecodedMessage =
  | { channel: 'sync'; reply: Uint8Array | null }
  | { channel: 'awareness' }
  | { channel: 'unknown'; type: number };

/**
 * Apply an inbound frame to the room's document or awareness state.
 *
 * `origin` tags the resulting Yjs transaction so the room's own update handler can
 * tell "this came from socket X" and skip echoing it back to the sender.
 *
 * Returns a reply frame when the sync protocol requires one (a step 1 must be
 * answered with a step 2), or null otherwise.
 */
export function applyMessage(
  data: Uint8Array,
  doc: Y.Doc,
  awareness: awarenessProtocol.Awareness,
  origin: unknown,
): DecodedMessage {
  const decoder = decoding.createDecoder(data);
  const messageType = decoding.readVarUint(decoder);

  switch (messageType) {
    case MESSAGE_SYNC: {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.readSyncMessage(decoder, encoder, doc, origin);

      // readSyncMessage only writes a payload when a response is owed. A frame
      // containing nothing but the channel header would be a wasted round trip.
      const hasReply = encoding.length(encoder) > 1;
      return { channel: 'sync', reply: hasReply ? encoding.toUint8Array(encoder) : null };
    }

    case MESSAGE_AWARENESS: {
      awarenessProtocol.applyAwarenessUpdate(
        awareness,
        decoding.readVarUint8Array(decoder),
        origin,
      );
      return { channel: 'awareness' };
    }

    default:
      // Forward compatibility: a newer client sending a channel we do not know
      // should be ignored, not disconnected.
      return { channel: 'unknown', type: messageType };
  }
}
