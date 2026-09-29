import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from 'fastify';
import { z } from 'zod';
import type { SessionUser } from '../auth/session.ts';
import { CLOSE_ACCESS_CHANGED, roomAccess } from './policy.ts';
import { ROLES, type AccessStore, type Role } from './store.ts';

export interface AccessRouteDeps {
  store: AccessStore;
  readUser: (request: FastifyRequest) => Promise<SessionUser | null>;
  parseRoomId: (raw: unknown) => string | null;
  /** Close every socket on these rooms so each client re-authorises. */
  disconnect: (roomIds: readonly string[], code: number, reason: string) => Promise<void>;
  /** Remove a room from memory and storage for good, closing its sockets. */
  deleteRoom: (roomId: string) => Promise<void>;
  isDeleted: (roomId: string) => Promise<boolean>;
  publicUrl: string;
  inviteTtlMs: number;
  limit: RouteShorthandOptions;
  /** For the access check every board load makes. */
  readLimit: RouteShorthandOptions;
}

const NameSchema = z.string().trim().min(1).max(80);
const WorkspaceIdSchema = z.uuid();
const UserIdSchema = z.string().min(1).max(200);
const RoleSchema = z.enum(ROLES as unknown as [Role, ...Role[]]);
const InviteRoleSchema = z.enum(['editor', 'viewer']);

/**
 * Workspaces, membership, invites, room placement and ingest tokens.
 *
 * Signing in is what creates standing here: every route that changes who may
 * do what needs a session. Invites are links carrying a secret rather than
 * invitations by username, so they work the same for any sign-in provider and
 * need no directory of users to search.
 */
export function registerAccessRoutes(app: FastifyInstance, deps: AccessRouteDeps): void {
  const { store } = deps;

  const requireUser = async (request: FastifyRequest, reply: FastifyReply): Promise<SessionUser | null> => {
    const user = await deps.readUser(request);
    if (!user) void reply.status(401).send({ error: 'sign in first' });
    return user;
  };

  const workspaceRole = async (workspaceId: string, user: SessionUser) => store.roleOf(workspaceId, user.id);

  const roomsOf = async (workspaceId: string) => (await store.roomsIn(workspaceId)).map((r) => r.roomId);

  // --- Rooms ---------------------------------------------------------------

  app.get('/api/rooms/:roomId/access', deps.readLimit, async (request, reply) => {
    const roomId = deps.parseRoomId((request.params as { roomId?: unknown }).roomId);
    if (!roomId) return reply.status(400).send({ error: 'invalid room id' });
    const user = await deps.readUser(request);
    if (await deps.isDeleted(roomId)) {
      return { deleted: true, visibility: 'link', role: null, canView: false, canEdit: false, canManage: false, signedIn: user !== null };
    }
    const access = await roomAccess(store, roomId, user?.id ?? null);
    return {
      visibility: access.visibility,
      role: access.role,
      canView: access.canView,
      canEdit: access.canEdit,
      canManage: access.canManage,
      signedIn: user !== null,
      // A workspace's name and the room's are for members; a stranger holding
      // the link learns only that it is private.
      ...(access.canView && access.workspace
        ? { workspace: { id: access.workspace.id, name: access.workspace.name }, name: access.placement?.name ?? null }
        : {}),
    };
  });

  app.put('/api/rooms/:roomId/workspace', deps.limit, async (request, reply) => {
    const roomId = deps.parseRoomId((request.params as { roomId?: unknown }).roomId);
    if (!roomId) return reply.status(400).send({ error: 'invalid room id' });
    const body = z.object({ workspaceId: WorkspaceIdSchema, name: NameSchema }).safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: 'invalid request', issues: body.error.issues });
    const user = await requireUser(request, reply);
    if (!user) return reply;

    const access = await roomAccess(store, roomId, user.id);
    if (!access.canManage) return reply.status(403).send({ error: 'only an owner can move this room' });
    const target = await workspaceRole(body.data.workspaceId, user);
    if (target !== 'owner' && target !== 'editor') {
      return reply.status(403).send({ error: 'you can only move rooms into workspaces you can edit' });
    }

    await store.placeRoom({ roomId, workspaceId: body.data.workspaceId, name: body.data.name, movedBy: user.id, movedAt: new Date().toISOString() });
    await deps.disconnect([roomId], CLOSE_ACCESS_CHANGED, 'access changed');
    return { visibility: 'workspace', workspaceId: body.data.workspaceId, name: body.data.name };
  });

  app.patch('/api/rooms/:roomId/workspace', deps.limit, async (request, reply) => {
    const roomId = deps.parseRoomId((request.params as { roomId?: unknown }).roomId);
    if (!roomId) return reply.status(400).send({ error: 'invalid room id' });
    const body = z.object({ name: NameSchema }).safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: 'invalid request', issues: body.error.issues });
    const user = await requireUser(request, reply);
    if (!user) return reply;
    const access = await roomAccess(store, roomId, user.id);
    if (access.visibility !== 'workspace' || !access.canEdit) return reply.status(403).send({ error: 'not allowed' });
    await store.renameRoom(roomId, body.data.name);
    return { name: body.data.name };
  });

  app.delete('/api/rooms/:roomId/workspace', deps.limit, async (request, reply) => {
    const roomId = deps.parseRoomId((request.params as { roomId?: unknown }).roomId);
    if (!roomId) return reply.status(400).send({ error: 'invalid room id' });
    const user = await requireUser(request, reply);
    if (!user) return reply;
    const access = await roomAccess(store, roomId, user.id);
    if (access.visibility !== 'workspace' || !access.canManage) return reply.status(403).send({ error: 'only an owner can do this' });
    await store.releaseRoom(roomId);
    await deps.disconnect([roomId], CLOSE_ACCESS_CHANGED, 'access changed');
    return reply.status(204).send();
  });

  /**
   * Delete a diagram for good. Only a workspace owner can: a link room has no
   * owner to ask, so deleting one is left open as a decision rather than
   * handed to whoever holds the link.
   */
  app.delete('/api/rooms/:roomId', deps.limit, async (request, reply) => {
    const roomId = deps.parseRoomId((request.params as { roomId?: unknown }).roomId);
    if (!roomId) return reply.status(400).send({ error: 'invalid room id' });
    const user = await requireUser(request, reply);
    if (!user) return reply;
    const access = await roomAccess(store, roomId, user.id);
    if (access.visibility !== 'workspace' || !access.canManage) {
      return reply.status(403).send({ error: 'only an owner of the workspace can delete a diagram' });
    }
    await deps.deleteRoom(roomId);
    return reply.status(204).send();
  });

  // --- Ingest tokens -------------------------------------------------------

  const tokenRoom = async (request: FastifyRequest, reply: FastifyReply) => {
    const roomId = deps.parseRoomId((request.params as { roomId?: unknown }).roomId);
    if (!roomId) {
      void reply.status(400).send({ error: 'invalid room id' });
      return null;
    }
    const user = await requireUser(request, reply);
    if (!user) return null;
    const access = await roomAccess(store, roomId, user.id);
    if (access.visibility !== 'workspace') {
      void reply.status(409).send({ error: 'a link room accepts observations without a token' });
      return null;
    }
    if (!access.canEdit) {
      void reply.status(403).send({ error: 'not allowed' });
      return null;
    }
    return { roomId, user };
  };

  app.get('/api/rooms/:roomId/ingest-tokens', deps.limit, async (request, reply) => {
    const ctx = await tokenRoom(request, reply);
    if (!ctx) return reply;
    return { tokens: await store.ingestTokens(ctx.roomId) };
  });

  app.post('/api/rooms/:roomId/ingest-tokens', deps.limit, async (request, reply) => {
    const ctx = await tokenRoom(request, reply);
    if (!ctx) return reply;
    const body = z.object({ name: NameSchema }).safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: 'invalid request', issues: body.error.issues });
    const { token, secret } = await store.createIngestToken(ctx.roomId, body.data.name, ctx.user.id);
    // The only time the secret is ever returned.
    return reply.status(201).send({ token, secret });
  });

  app.delete('/api/rooms/:roomId/ingest-tokens/:tokenId', deps.limit, async (request, reply) => {
    const ctx = await tokenRoom(request, reply);
    if (!ctx) return reply;
    const tokenId = z.uuid().safeParse((request.params as { tokenId?: unknown }).tokenId);
    if (!tokenId.success) return reply.status(400).send({ error: 'invalid token id' });
    await store.revokeIngestToken(ctx.roomId, tokenId.data);
    return reply.status(204).send();
  });

  // --- Workspaces ----------------------------------------------------------

  app.get('/api/workspaces', deps.limit, async (request, reply) => {
    const user = await requireUser(request, reply);
    if (!user) return reply;
    return { workspaces: await store.workspacesFor(user.id) };
  });

  app.post('/api/workspaces', deps.limit, async (request, reply) => {
    const body = z.object({ name: NameSchema }).safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: 'invalid request', issues: body.error.issues });
    const user = await requireUser(request, reply);
    if (!user) return reply;
    const workspace = await store.createWorkspace(body.data.name, user.id);
    return reply.status(201).send({ workspace: { ...workspace, role: 'owner' } });
  });

  const memberOf = async (request: FastifyRequest, reply: FastifyReply) => {
    const id = WorkspaceIdSchema.safeParse((request.params as { workspaceId?: unknown }).workspaceId);
    if (!id.success) {
      void reply.status(400).send({ error: 'invalid workspace id' });
      return null;
    }
    const user = await requireUser(request, reply);
    if (!user) return null;
    const role = await workspaceRole(id.data, user);
    // Not a member reads as not found: a workspace id is not something to confirm to strangers.
    if (!role) {
      void reply.status(404).send({ error: 'workspace not found' });
      return null;
    }
    return { workspaceId: id.data, user, role };
  };

  app.get('/api/workspaces/:workspaceId', deps.limit, async (request, reply) => {
    const ctx = await memberOf(request, reply);
    if (!ctx) return reply;
    const workspace = await store.getWorkspace(ctx.workspaceId);
    return {
      workspace,
      role: ctx.role,
      members: await store.members(ctx.workspaceId),
      rooms: await store.roomsIn(ctx.workspaceId),
      ...(ctx.role === 'owner' ? { invites: await store.invites(ctx.workspaceId) } : {}),
    };
  });

  app.patch('/api/workspaces/:workspaceId', deps.limit, async (request, reply) => {
    const ctx = await memberOf(request, reply);
    if (!ctx) return reply;
    if (ctx.role !== 'owner') return reply.status(403).send({ error: 'only an owner can rename a workspace' });
    const body = z.object({ name: NameSchema }).safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: 'invalid request', issues: body.error.issues });
    await store.renameWorkspace(ctx.workspaceId, body.data.name);
    return { name: body.data.name };
  });

  /** A workspace must always keep an owner, or nobody could ever manage it again. */
  const wouldLeaveNoOwner = async (workspaceId: string, userId: string, nextRole: Role | null) => {
    if (nextRole === 'owner') return false;
    const members = await store.members(workspaceId);
    const owners = members.filter((m) => m.role === 'owner');
    return owners.length === 1 && owners[0]?.id === userId;
  };

  app.put('/api/workspaces/:workspaceId/members/:userId', deps.limit, async (request, reply) => {
    const ctx = await memberOf(request, reply);
    if (!ctx) return reply;
    if (ctx.role !== 'owner') return reply.status(403).send({ error: 'only an owner can change roles' });
    const target = UserIdSchema.safeParse((request.params as { userId?: unknown }).userId);
    const body = z.object({ role: RoleSchema }).safeParse(request.body);
    if (!target.success || !body.success) return reply.status(400).send({ error: 'invalid request' });
    if (!(await store.roleOf(ctx.workspaceId, target.data))) return reply.status(404).send({ error: 'not a member' });
    if (await wouldLeaveNoOwner(ctx.workspaceId, target.data, body.data.role)) {
      return reply.status(409).send({ error: 'a workspace needs at least one owner' });
    }
    await store.setRole(ctx.workspaceId, target.data, body.data.role);
    await deps.disconnect(await roomsOf(ctx.workspaceId), CLOSE_ACCESS_CHANGED, 'access changed');
    return { role: body.data.role };
  });

  app.delete('/api/workspaces/:workspaceId/members/:userId', deps.limit, async (request, reply) => {
    const ctx = await memberOf(request, reply);
    if (!ctx) return reply;
    const target = UserIdSchema.safeParse((request.params as { userId?: unknown }).userId);
    if (!target.success) return reply.status(400).send({ error: 'invalid user id' });
    const leaving = target.data === ctx.user.id;
    if (!leaving && ctx.role !== 'owner') return reply.status(403).send({ error: 'only an owner can remove members' });
    if (await wouldLeaveNoOwner(ctx.workspaceId, target.data, null)) {
      return reply.status(409).send({ error: 'a workspace needs at least one owner' });
    }
    await store.removeMember(ctx.workspaceId, target.data);
    await deps.disconnect(await roomsOf(ctx.workspaceId), CLOSE_ACCESS_CHANGED, 'access changed');
    return reply.status(204).send();
  });

  // --- Invites -------------------------------------------------------------

  app.post('/api/workspaces/:workspaceId/invites', deps.limit, async (request, reply) => {
    const ctx = await memberOf(request, reply);
    if (!ctx) return reply;
    if (ctx.role !== 'owner') return reply.status(403).send({ error: 'only an owner can invite' });
    const body = z.object({ role: InviteRoleSchema.default('editor') }).safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: 'invalid request', issues: body.error.issues });
    const { invite, token } = await store.createInvite(ctx.workspaceId, body.data.role, ctx.user.id, deps.inviteTtlMs);
    return reply.status(201).send({ invite, url: `${new URL(deps.publicUrl).origin}/invite/${token}` });
  });

  app.delete('/api/workspaces/:workspaceId/invites/:inviteId', deps.limit, async (request, reply) => {
    const ctx = await memberOf(request, reply);
    if (!ctx) return reply;
    if (ctx.role !== 'owner') return reply.status(403).send({ error: 'only an owner can revoke invites' });
    const inviteId = z.uuid().safeParse((request.params as { inviteId?: unknown }).inviteId);
    if (!inviteId.success) return reply.status(400).send({ error: 'invalid invite id' });
    await store.revokeInvite(ctx.workspaceId, inviteId.data);
    return reply.status(204).send();
  });

  const InviteTokenSchema = z.string().regex(/^keel_inv_[A-Za-z0-9_-]{16,64}$/);

  app.get('/api/invites/:token', deps.limit, async (request, reply) => {
    const token = InviteTokenSchema.safeParse((request.params as { token?: unknown }).token);
    if (!token.success) return reply.status(404).send({ error: 'invite not found or expired' });
    const invite = await store.resolveInvite(token.data, Date.now());
    if (!invite) return reply.status(404).send({ error: 'invite not found or expired' });
    const workspace = await store.getWorkspace(invite.workspaceId);
    return { workspace: { name: workspace?.name ?? 'a workspace' }, role: invite.role, expiresAt: invite.expiresAt };
  });

  app.post('/api/invites/:token/accept', deps.limit, async (request, reply) => {
    const token = InviteTokenSchema.safeParse((request.params as { token?: unknown }).token);
    if (!token.success) return reply.status(404).send({ error: 'invite not found or expired' });
    const user = await requireUser(request, reply);
    if (!user) return reply;
    const invite = await store.resolveInvite(token.data, Date.now());
    if (!invite) return reply.status(404).send({ error: 'invite not found or expired' });

    // Accepting never lowers a role someone already has.
    const current = await store.roleOf(invite.workspaceId, user.id);
    const rank: Record<Role, number> = { owner: 0, editor: 1, viewer: 2 };
    const role = current && rank[current] <= rank[invite.role] ? current : invite.role;
    await store.setRole(invite.workspaceId, user.id, role);
    return { workspaceId: invite.workspaceId, role };
  });
}
