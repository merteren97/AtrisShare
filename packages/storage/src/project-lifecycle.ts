import type { DatabaseSync } from "node:sqlite";
import type { WorkspaceContext } from "../../domain/src/workspace.js";

/** Caller owns BEGIN IMMEDIATE. Keep terminal receipts/history and every physical file.
 * Revoking owners fences late worker writes even after the project is restored.
 */
export function invalidateProjectWork(db: DatabaseSync, scope: WorkspaceContext, stamp: string): void {
  const args = [scope.accountId, scope.projectId] as const;
  db.prepare(`UPDATE sequence_work SET cancel_requested=1,owner=NULL,lease_until=0,
    data=json_set(data,'$.state','cancelled','$.error',NULL)
    WHERE account_id=? AND project_id=? AND json_extract(data,'$.state') IN('running','ready')`).run(...args);
  db.prepare(`UPDATE ai_runs SET cancel_requested=1,owner='',lease_until=0,
    data=json_set(data,'$.state','cancelled','$.cancelRequested',json('true'),'$.summary',NULL,'$.edit',NULL,'$.error',NULL)
    WHERE account_id=? AND project_id=? AND json_extract(data,'$.state') IN('running','ready')`).run(...args);
  db.prepare(`UPDATE renders SET owner='',lease_until=0,data=json_set(data,'$.state','cancelled','$.error',NULL)
    WHERE account_id=? AND project_id=? AND json_extract(data,'$.state')='running'`).run(...args);
  db.prepare(`UPDATE transcripts SET cancel_requested=1,owner='',lease_until=0,
    data=json_set(data,'$.state','cancelled','$.cancelRequested',json('true'),'$.segments',json('[]'),
      '$.language',NULL,'$.duration',NULL,'$.error',NULL,'$.updatedAt',?)
    WHERE account_id=? AND project_id=? AND json_extract(data,'$.state')='running'`).run(stamp, ...args);
  db.prepare(`UPDATE clip_analyses SET cancel_requested=1,owner='',lease_until=0,
    data=json_set(data,'$.state','cancelled','$.cancelRequested',json('true'),'$.error',NULL)
    WHERE account_id=? AND project_id=? AND json_extract(data,'$.state') IN('running','ready')`).run(...args);
  db.prepare(`UPDATE schedules SET data=json_set(data,'$.state','cancelled','$.nextDueAt',NULL,
    '$.revision',json_extract(data,'$.revision')+1)
    WHERE account_id=? AND project_id=? AND json_extract(data,'$.state') IN('active','paused')`).run(...args);
  db.prepare(`UPDATE schedule_occurrences SET data=json_set(data,'$.state','cancelled')
    WHERE account_id=? AND project_id=? AND json_extract(data,'$.state') IN('scheduled','awaiting-approval','blocked')`).run(...args);
  // A request already accepted remotely is not undone. Preserve processing,
  // uncertain and successful receipts; stop subsequent local dispatch instead.
  db.prepare(`UPDATE publications SET dispatch_revoked=1,
    data=CASE WHEN json_extract(data,'$.state')='review' THEN json_set(data,'$.state','cancelled') ELSE data END
    WHERE account_id=? AND project_id=?`).run(...args);
  db.prepare(`UPDATE social_posts SET dispatch_revoked=1,
    data=CASE WHEN json_extract(data,'$.state')='review' THEN json_set(data,'$.state','cancelled','$.dispatchRevoked',json('true'))
      ELSE json_set(data,'$.dispatchRevoked',json('true')) END
    WHERE account_id=? AND project_id=?`).run(...args);
}
