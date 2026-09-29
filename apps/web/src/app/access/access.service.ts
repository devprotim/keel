import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { KEEL_CONFIG } from '../core/app-config';

export type Role = 'owner' | 'editor' | 'viewer';

/** What the server says this browser may do in a room. */
export interface RoomAccess {
  /** The room was deleted; nothing more can be done with it. */
  deleted?: boolean;
  visibility: 'link' | 'workspace';
  role: Role | null;
  canView: boolean;
  canEdit: boolean;
  canManage: boolean;
  signedIn: boolean;
  workspace?: { id: string; name: string };
  name?: string | null;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  role: Role;
}

export interface Member {
  id: string;
  name: string;
  avatarUrl: string | null;
  role: Role;
}

export interface WorkspaceDetail {
  workspace: { id: string; name: string };
  role: Role;
  members: Member[];
  rooms: { roomId: string; name: string; movedAt: string }[];
  invites?: { id: string; role: Role; expiresAt: string }[];
}

export type PlanId = 'free' | 'team' | 'business';

export interface Plan {
  id: PlanId;
  name: string;
  limits: { editors: number | null; rooms: number | null; collectors: number | null; pagerDuty: boolean };
}

/** A workspace's plan and how much of it is used. `enabled: false` means billing is off on this server. */
export type Billing =
  | { enabled: false }
  | {
      enabled: true;
      plan: Plan;
      status: string | null;
      periodEnd: string | null;
      usage: { editors: number; viewers: number; rooms: number; collectors: number };
      canManage: boolean;
      hasCustomer: boolean;
      purchasable: Plan[];
    };

export interface IngestToken {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/**
 * The workspace and access API, typed. Stateless: callers keep whatever they
 * show, so nothing here can go stale behind a component's back.
 */
@Injectable({ providedIn: 'root' })
export class AccessService {
  readonly #http = inject(HttpClient);
  readonly #api = inject(KEEL_CONFIG).apiUrl;

  roomAccess(roomId: string): Promise<RoomAccess> {
    return this.#get(`/api/rooms/${encodeURIComponent(roomId)}/access`);
  }

  workspaces(): Promise<WorkspaceSummary[]> {
    return this.#get<{ workspaces: WorkspaceSummary[] }>('/api/workspaces').then((r) => r.workspaces);
  }

  workspace(id: string): Promise<WorkspaceDetail> {
    return this.#get(`/api/workspaces/${id}`);
  }

  createWorkspace(name: string): Promise<WorkspaceSummary> {
    return this.#send<{ workspace: WorkspaceSummary }>('POST', '/api/workspaces', { name }).then((r) => r.workspace);
  }

  moveRoom(roomId: string, workspaceId: string, name: string): Promise<void> {
    return this.#send('PUT', `/api/rooms/${encodeURIComponent(roomId)}/workspace`, { workspaceId, name });
  }

  renameRoom(roomId: string, name: string): Promise<void> {
    return this.#send('PATCH', `/api/rooms/${encodeURIComponent(roomId)}/workspace`, { name });
  }

  deleteRoom(roomId: string): Promise<void> {
    return this.#send('DELETE', `/api/rooms/${encodeURIComponent(roomId)}`);
  }

  releaseRoom(roomId: string): Promise<void> {
    return this.#send('DELETE', `/api/rooms/${encodeURIComponent(roomId)}/workspace`);
  }

  setRole(workspaceId: string, userId: string, role: Role): Promise<void> {
    return this.#send('PUT', `/api/workspaces/${workspaceId}/members/${encodeURIComponent(userId)}`, { role });
  }

  removeMember(workspaceId: string, userId: string): Promise<void> {
    return this.#send('DELETE', `/api/workspaces/${workspaceId}/members/${encodeURIComponent(userId)}`);
  }

  createInvite(workspaceId: string, role: 'editor' | 'viewer'): Promise<{ url: string }> {
    return this.#send('POST', `/api/workspaces/${workspaceId}/invites`, { role });
  }

  revokeInvite(workspaceId: string, inviteId: string): Promise<void> {
    return this.#send('DELETE', `/api/workspaces/${workspaceId}/invites/${inviteId}`);
  }

  invite(token: string): Promise<{ workspace: { name: string }; role: Role; expiresAt: string }> {
    return this.#get(`/api/invites/${encodeURIComponent(token)}`);
  }

  acceptInvite(token: string): Promise<{ workspaceId: string; role: Role }> {
    return this.#send('POST', `/api/invites/${encodeURIComponent(token)}/accept`);
  }

  ingestTokens(roomId: string): Promise<IngestToken[]> {
    return this.#get<{ tokens: IngestToken[] }>(`/api/rooms/${encodeURIComponent(roomId)}/ingest-tokens`).then((r) => r.tokens);
  }

  createIngestToken(roomId: string, name: string): Promise<{ token: IngestToken; secret: string }> {
    return this.#send('POST', `/api/rooms/${encodeURIComponent(roomId)}/ingest-tokens`, { name });
  }

  revokeIngestToken(roomId: string, tokenId: string): Promise<void> {
    return this.#send('DELETE', `/api/rooms/${encodeURIComponent(roomId)}/ingest-tokens/${tokenId}`);
  }

  billing(workspaceId: string): Promise<Billing> {
    return this.#get(`/api/workspaces/${workspaceId}/billing`);
  }

  /** A Stripe Checkout URL for upgrading. The caller navigates to it. */
  checkout(workspaceId: string, plan: Exclude<PlanId, 'free'>): Promise<{ url: string }> {
    return this.#send('POST', `/api/workspaces/${workspaceId}/billing/checkout`, { plan });
  }

  /** A Stripe billing portal URL, for changing plan, card or cancelling. */
  billingPortal(workspaceId: string): Promise<{ url: string }> {
    return this.#send('POST', `/api/workspaces/${workspaceId}/billing/portal`);
  }

  #get<T>(path: string): Promise<T> {
    return firstValueFrom(this.#http.get<T>(`${this.#api}${path}`));
  }

  #send<T>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
    return firstValueFrom(this.#http.request<T>(method, `${this.#api}${path}`, { body: body ?? {} }));
  }
}

/** The server's reason, when it gave one, for showing next to the control that failed. */
export function describeError(error: unknown, fallback: string): string {
  if (error instanceof HttpErrorResponse) {
    if (error.status === 429) return 'Too many changes. Wait a minute and try again.';
    const body = error.error as { error?: string; issues?: { message?: string }[] } | null;
    const reason = body?.issues?.[0]?.message ?? body?.error;
    if (reason) return reason.charAt(0).toUpperCase() + reason.slice(1) + (/[.!?]$/.test(reason) ? '' : '.');
  }
  return fallback;
}
