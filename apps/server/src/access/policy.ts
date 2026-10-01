import type { AccessStore, Role, RoomPlacement, Workspace } from './store.ts';

export interface RoomAccess {
  /** `link`: anyone with the id. `workspace`: members only. */
  visibility: 'link' | 'workspace';
  /** The caller's workspace role, when the room is in one and they are a member. */
  role: Role | null;
  canView: boolean;
  canEdit: boolean;
  /** Owners of the workspace, or anyone at all for a link room. */
  canManage: boolean;
  workspace: Workspace | null;
  placement: RoomPlacement | null;
}

/**
 * The single answer to "what may this caller do in this room". Every route and
 * the socket ask it, so a rule can't be enforced in one place and forgotten in
 * another.
 *
 * A link room is fully open, which includes moving it into a workspace: anyone
 * holding the link can already delete every box in it. That is the current
 * default for who may claim a room, and the obvious one to revisit.
 */
export async function roomAccess(store: AccessStore, roomId: string, userId: string | null): Promise<RoomAccess> {
  const placement = await store.placementOf(roomId);
  if (!placement) {
    return { visibility: 'link', role: null, canView: true, canEdit: true, canManage: true, workspace: null, placement: null };
  }

  const workspace = await store.getWorkspace(placement.workspaceId);
  const role = userId ? await store.roleOf(placement.workspaceId, userId) : null;
  return {
    visibility: 'workspace',
    role,
    canView: role !== null,
    canEdit: role === 'owner' || role === 'editor',
    canManage: role === 'owner',
    workspace,
    placement,
  };
}

/** Close codes for sockets, in the application range (4000-4999). */
export const CLOSE_ACCESS_CHANGED = 4001;
export const CLOSE_FORBIDDEN = 4003;
/** The room was deleted. A client should drop its offline copy rather than sync it back. */
export const CLOSE_DELETED = 4004;
/** No such room: it was never created through `POST /api/rooms`. */
export const CLOSE_NOT_FOUND = 4005;
