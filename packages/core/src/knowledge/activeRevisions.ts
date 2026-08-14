/**
 * Session-active knowledge revisions are pinned separately from the latest
 * valid saved revision. Saves never hot-reload the Agent; the user must apply.
 */

export type ActiveObjectKind = 'environment' | 'knowledge' | 'host-notes';

/** Revision the Agent currently uses for one object. */
export interface ActiveRevisionPin {
  objectId: string;
  kind: ActiveObjectKind;
  name: string;
  revision: number;
  contentHash: string;
  /**
   * Frozen body for Host Notes (they lack managed revision roots).
   * Managed environment/knowledge objects read from revision directories instead.
   */
  contentSnapshot?: string;
}

/** Latest valid revision currently available on disk (or host notes). */
export interface LatestRevisionSnapshot {
  objectId: string;
  kind: ActiveObjectKind;
  name: string;
  revision: number;
  contentHash: string;
  contentSnapshot?: string;
}

export interface RevisionUpdateAvailable {
  objectId: string;
  kind: ActiveObjectKind;
  name: string;
  activeRevision: number;
  activeContentHash: string;
  latestRevision: number;
  latestContentHash: string;
}

/** User confirmation to apply a specific target revision from the next request. */
export interface PendingRevisionApply {
  objectId: string;
  kind: ActiveObjectKind;
  name: string;
  targetRevision: number;
  targetContentHash: string;
  confirmedAt: string;
}

export interface VersionSwitchEvent {
  objectId: string;
  kind: ActiveObjectKind;
  name: string;
  fromRevision: number;
  fromContentHash: string;
  toRevision: number;
  toContentHash: string;
  appliedAt: string;
}

export type ApplyPendingRevisionResult =
  | { ok: true; pin: ActiveRevisionPin; event: VersionSwitchEvent }
  | { ok: false; reason: 'stale-target' | 'not-active' | 'missing-latest' };

/** Stable key for dismissed "continue current version" acknowledgements. */
export function dismissedUpdateKey(objectId: string, latestRevision: number, latestContentHash: string): string {
  return `${objectId}@${latestRevision}:${latestContentHash}`;
}

/**
 * Pin an object at first activation. Later latest saves do not overwrite the pin.
 */
export function ensureActivePin(
  pins: Map<string, ActiveRevisionPin>,
  latest: LatestRevisionSnapshot,
): { pin: ActiveRevisionPin; created: boolean } {
  const existing = pins.get(latest.objectId);
  if (existing) {
    return { pin: existing, created: false };
  }
  const pin: ActiveRevisionPin = {
    objectId: latest.objectId,
    kind: latest.kind,
    name: latest.name,
    revision: latest.revision,
    contentHash: latest.contentHash,
    ...(latest.contentSnapshot !== undefined ? { contentSnapshot: latest.contentSnapshot } : {}),
  };
  pins.set(latest.objectId, pin);
  return { pin, created: true };
}

/**
 * Compare active pins to latest snapshots. Only active objects can show updates.
 * Dismissed keys suppress a specific latest revision until the target changes.
 */
export function detectRevisionUpdates(
  pins: ReadonlyMap<string, ActiveRevisionPin>,
  latestSnapshots: readonly LatestRevisionSnapshot[],
  dismissed: ReadonlySet<string> = new Set(),
): RevisionUpdateAvailable[] {
  const byId = new Map(latestSnapshots.map((snapshot) => [snapshot.objectId, snapshot]));
  const updates: RevisionUpdateAvailable[] = [];
  for (const pin of pins.values()) {
    const latest = byId.get(pin.objectId);
    if (!latest) continue;
    if (latest.revision === pin.revision && latest.contentHash === pin.contentHash) continue;
    const key = dismissedUpdateKey(pin.objectId, latest.revision, latest.contentHash);
    if (dismissed.has(key)) continue;
    updates.push({
      objectId: pin.objectId,
      kind: pin.kind,
      name: latest.name || pin.name,
      activeRevision: pin.revision,
      activeContentHash: pin.contentHash,
      latestRevision: latest.revision,
      latestContentHash: latest.contentHash,
    });
  }
  return updates.sort((left, right) => left.name.localeCompare(right.name, 'en-US'));
}

/** "Continue using current version" for one concrete latest snapshot. */
export function dismissRevisionUpdate(
  dismissed: ReadonlySet<string>,
  update: Pick<RevisionUpdateAvailable, 'objectId' | 'latestRevision' | 'latestContentHash'>,
): Set<string> {
  const next = new Set(dismissed);
  next.add(dismissedUpdateKey(update.objectId, update.latestRevision, update.latestContentHash));
  return next;
}

export function createPendingRevisionApply(
  latest: LatestRevisionSnapshot,
  confirmedAt: string,
): PendingRevisionApply {
  return {
    objectId: latest.objectId,
    kind: latest.kind,
    name: latest.name,
    targetRevision: latest.revision,
    targetContentHash: latest.contentHash,
    confirmedAt,
  };
}

/**
 * Apply a confirmed target revision. Re-checks the live latest snapshot so a
 * concurrent save after confirmation cannot silently land on the wrong content.
 */
export function applyPendingRevision(
  pins: Map<string, ActiveRevisionPin>,
  pending: PendingRevisionApply,
  currentLatest: LatestRevisionSnapshot | undefined,
  appliedAt: string = pending.confirmedAt,
): ApplyPendingRevisionResult {
  const existing = pins.get(pending.objectId);
  if (!existing) {
    return { ok: false, reason: 'not-active' };
  }
  if (!currentLatest) {
    return { ok: false, reason: 'missing-latest' };
  }
  if (
    currentLatest.revision !== pending.targetRevision
    || currentLatest.contentHash !== pending.targetContentHash
  ) {
    return { ok: false, reason: 'stale-target' };
  }

  const nextPin: ActiveRevisionPin = {
    objectId: existing.objectId,
    kind: currentLatest.kind,
    name: currentLatest.name || existing.name,
    revision: pending.targetRevision,
    contentHash: pending.targetContentHash,
    ...(currentLatest.contentSnapshot !== undefined
      ? { contentSnapshot: currentLatest.contentSnapshot }
      : existing.contentSnapshot !== undefined
        ? { contentSnapshot: existing.contentSnapshot }
        : {}),
  };
  pins.set(pending.objectId, nextPin);

  const event: VersionSwitchEvent = {
    objectId: nextPin.objectId,
    kind: nextPin.kind,
    name: nextPin.name,
    fromRevision: existing.revision,
    fromContentHash: existing.contentHash,
    toRevision: nextPin.revision,
    toContentHash: nextPin.contentHash,
    appliedAt,
  };
  return { ok: true, pin: nextPin, event };
}

/** Deterministic context event for the next model request after an apply. */
export function formatVersionSwitchContextEvent(event: VersionSwitchEvent): string {
  return [
    'Knowledge revision switch:',
    `- object: ${event.name} (${event.objectId})`,
    `- kind: ${event.kind}`,
    `- from: revision ${event.fromRevision} hash ${event.fromContentHash}`,
    `- to: revision ${event.toRevision} hash ${event.toContentHash}`,
    `- appliedAt: ${event.appliedAt}`,
    'Answers before this event used the previous revision; subsequent reads use the new revision.',
  ].join('\n');
}

/** Host Notes identity for a session (stable per host). */
export const HOST_NOTES_OBJECT_PREFIX = 'host-notes:';

export function hostNotesObjectId(hostId: string): string {
  return `${HOST_NOTES_OBJECT_PREFIX}${hostId}`;
}

export function isHostNotesObjectId(objectId: string): boolean {
  return objectId.startsWith(HOST_NOTES_OBJECT_PREFIX);
}
