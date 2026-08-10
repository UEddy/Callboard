UPDATE submissions SET submitted_at = submitted_at - 10368000 WHERE submitted_at IS NOT NULL;
UPDATE submissions SET decided_at = decided_at - 10368000 WHERE decided_at IS NOT NULL;
UPDATE submissions SET notified_at = notified_at - 10368000 WHERE notified_at IS NOT NULL;
UPDATE task_assignments SET completed_at = completed_at - 10368000 WHERE completed_at IS NOT NULL;
UPDATE task_assignments SET last_nudged_at = last_nudged_at - 10368000 WHERE last_nudged_at IS NOT NULL;