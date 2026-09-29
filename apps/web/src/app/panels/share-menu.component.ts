import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import {
  AccessService,
  describeError,
  type IngestToken,
  type Role,
  type RoomAccess,
  type WorkspaceDetail,
  type WorkspaceSummary,
} from '../access/access.service';
import { Router } from '@angular/router';
import { AuthService } from '../auth/auth.service';

const NEW_WORKSPACE = '__new__';

/**
 * Who can open this diagram, and changing that.
 *
 * A link room says so plainly and offers to move into a workspace; a workspace
 * room shows its members, invite links and collector tokens to whoever may
 * manage them. Every change is enforced by the server; this only asks.
 */
@Component({
  selector: 'keel-share-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './share-menu.component.html',
  styleUrl: './share-menu.component.scss',
  host: {
    '(document:pointerdown)': 'onDocumentPointerDown($event)',
    '(document:keydown.escape)': 'onEscape($event)',
  },
})
export class ShareMenuComponent {
  private readonly api = inject(AccessService);
  protected readonly auth = inject(AuthService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly router = inject(Router);

  readonly roomId = input.required<string>();
  readonly access = input.required<RoomAccess | null>();
  /** Emitted after anything that changes who may open the room. */
  readonly changed = output<void>();

  private readonly trigger = viewChild.required<ElementRef<HTMLButtonElement>>('trigger');

  readonly open = signal(false);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly copied = signal<string | null>(null);

  // Link room: moving it.
  readonly workspaces = signal<WorkspaceSummary[]>([]);
  readonly targetWorkspace = signal<string>(NEW_WORKSPACE);
  readonly newWorkspaceName = signal('');
  readonly roomName = signal('');

  // Workspace room.
  readonly detail = signal<WorkspaceDetail | null>(null);
  readonly inviteRole = signal<'editor' | 'viewer'>('editor');
  readonly inviteUrl = signal<string | null>(null);
  readonly tokens = signal<IngestToken[]>([]);
  readonly tokenName = signal('');
  readonly newSecret = signal<string | null>(null);

  readonly NEW_WORKSPACE = NEW_WORKSPACE;
  readonly roles: readonly Role[] = ['owner', 'editor', 'viewer'];
  readonly isPrivate = computed(() => this.access()?.visibility === 'workspace');
  readonly editableWorkspaces = computed(() => this.workspaces().filter((w) => w.role !== 'viewer'));
  readonly me = computed(() => this.auth.user()?.id ?? null);

  toggle(): void {
    if (this.open()) {
      this.close();
      return;
    }
    this.open.set(true);
    this.error.set(null);
    this.inviteUrl.set(null);
    this.newSecret.set(null);
    void this.load();
  }

  close(returnFocus = true): void {
    this.open.set(false);
    if (returnFocus) this.trigger().nativeElement.focus();
  }

  async load(): Promise<void> {
    const access = this.access();
    if (!access) return;
    this.roomName.set(access.name ?? '');
    try {
      if (access.visibility === 'workspace' && access.workspace) {
        this.detail.set(await this.api.workspace(access.workspace.id));
        this.tokens.set(access.canEdit ? await this.api.ingestTokens(this.roomId()) : []);
      } else if (this.auth.user()) {
        const workspaces = await this.api.workspaces();
        this.workspaces.set(workspaces);
        const firstEditable = workspaces.find((w) => w.role !== 'viewer');
        this.targetWorkspace.set(firstEditable?.id ?? NEW_WORKSPACE);
      }
    } catch (error) {
      this.error.set(describeError(error, 'Could not load sharing settings.'));
    }
  }

  async makePrivate(): Promise<void> {
    await this.run(async () => {
      let workspaceId = this.targetWorkspace();
      if (workspaceId === NEW_WORKSPACE) {
        const name = this.newWorkspaceName().trim();
        if (!name) throw new Error('Name the new workspace.');
        workspaceId = (await this.api.createWorkspace(name)).id;
      }
      await this.api.moveRoom(this.roomId(), workspaceId, this.roomName().trim() || 'Untitled diagram');
      this.changed.emit();
      this.close(false);
    }, 'Could not move the room.');
  }

  async renameRoom(): Promise<void> {
    await this.run(async () => {
      await this.api.renameRoom(this.roomId(), this.roomName().trim());
      this.changed.emit();
    }, 'Could not rename.');
  }

  async makeLinkShareable(): Promise<void> {
    await this.run(async () => {
      await this.api.releaseRoom(this.roomId());
      this.changed.emit();
      this.close(false);
    }, 'Could not change sharing.');
  }

  async deleteRoom(): Promise<void> {
    if (!globalThis.confirm('Delete this diagram for everyone? This cannot be undone.')) return;
    await this.run(async () => {
      await this.api.deleteRoom(this.roomId());
      this.close(false);
      void this.router.navigate(['/']);
    }, 'Could not delete the diagram.');
  }

  async createInvite(): Promise<void> {
    const workspace = this.access()?.workspace;
    if (!workspace) return;
    await this.run(async () => {
      this.inviteUrl.set((await this.api.createInvite(workspace.id, this.inviteRole())).url);
    }, 'Could not create an invite.');
  }

  async setRole(userId: string, role: Role): Promise<void> {
    const workspace = this.access()?.workspace;
    if (!workspace) return;
    await this.run(async () => {
      await this.api.setRole(workspace.id, userId, role);
      this.detail.set(await this.api.workspace(workspace.id));
    }, 'Could not change the role.');
  }

  async removeMember(userId: string): Promise<void> {
    const workspace = this.access()?.workspace;
    if (!workspace) return;
    await this.run(async () => {
      await this.api.removeMember(workspace.id, userId);
      if (userId === this.me()) {
        this.changed.emit();
        this.close(false);
        return;
      }
      this.detail.set(await this.api.workspace(workspace.id));
    }, 'Could not remove the member.');
  }

  async createToken(): Promise<void> {
    await this.run(async () => {
      const name = this.tokenName().trim() || 'Collector';
      const { secret } = await this.api.createIngestToken(this.roomId(), name);
      this.newSecret.set(secret);
      this.tokenName.set('');
      this.tokens.set(await this.api.ingestTokens(this.roomId()));
    }, 'Could not create a token.');
  }

  async revokeToken(tokenId: string): Promise<void> {
    await this.run(async () => {
      await this.api.revokeIngestToken(this.roomId(), tokenId);
      this.tokens.set(await this.api.ingestTokens(this.roomId()));
    }, 'Could not revoke the token.');
  }

  async copy(text: string, what: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.copied.set(what);
      setTimeout(() => this.copied.set(null), 1500);
    } catch {
      // Clipboard denied; the value is selectable in its field.
    }
  }

  signIn(): void {
    this.auth.loginWithGithub(`/${this.roomId()}`);
  }

  value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement).value;
  }

  asRole(value: string): Role {
    return (this.roles as readonly string[]).includes(value) ? (value as Role) : 'viewer';
  }

  asInviteRole(value: string): 'editor' | 'viewer' {
    return value === 'viewer' ? 'viewer' : 'editor';
  }

  describeLastUsed(token: IngestToken): string {
    return token.lastUsedAt ? `last used ${new Date(token.lastUsedAt).toLocaleString()}` : 'never used';
  }

  onEscape(event: Event): void {
    if (!this.open()) return;
    event.preventDefault();
    this.close();
  }

  onDocumentPointerDown(event: PointerEvent): void {
    if (!this.open()) return;
    if (!this.host.nativeElement.contains(event.target as Node)) this.close(false);
  }

  private async run(action: () => Promise<void>, fallback: string): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await action();
    } catch (error) {
      this.error.set(error instanceof Error && !('status' in error) ? error.message : describeError(error, fallback));
    } finally {
      this.busy.set(false);
    }
  }
}
