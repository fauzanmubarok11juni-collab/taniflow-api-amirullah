import type { Pool, PoolClient } from 'pg';

export type AuditAction = 'create' | 'update' | 'delete' | 'restore' | 'conflict_overwritten';

export interface AuditInput {
  entity: string;
  entityId: string;
  action: AuditAction;
  oldData?: unknown;
  newData?: unknown;
  userId: string;
  deviceId: string;
  clientOpId?: string;
}

export async function audit(db: Pool | PoolClient, a: AuditInput): Promise<void> {
  await db.query(
    `INSERT INTO audit_logs (entity, entity_id, action, old_data, new_data, user_id, device_id, client_op_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [a.entity, a.entityId, a.action, a.oldData ?? null, a.newData ?? null, a.userId, a.deviceId, a.clientOpId ?? null],
  );
}
