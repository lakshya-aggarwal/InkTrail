import { ConflictError, ValidationError } from '../domain/errors.js';
import { canonicalizeChapterTarget } from './job-repository.js';

function requireObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('input must be an object');
  return value;
}

function sameSelection(left, right) {
  return canonicalizeChapterTarget(left).targetJson === canonicalizeChapterTarget(right).targetJson;
}

function active(job) {
  return ['queued', 'running', 'retrying'].includes(job.state);
}

export function createJobService({ database, jobs, exports, runner }) {
  function jobResource(job) {
    const { targetHash, idempotencyKey, claimToken, claimedAt, ...resource } = job;
    return { ...resource, attemptCount: jobs.listJobAttempts({ novelId: job.novelId, jobId: job.id }).length };
  }

  function existingEpubJob(novelId, selection, idempotencyKey) {
    for (const job of jobs.listJobs(novelId)) {
      if (job.type !== 'build_epub' || (idempotencyKey ? job.idempotencyKey !== idempotencyKey : !active(job))) continue;
      const snapshot = exports.getExportSnapshot({ novelId, exportId: job.target.exportId });
      if (!sameSelection(snapshot.export.selection, selection)) {
        if (idempotencyKey) throw new ConflictError('idempotency key was already used for a different job');
        continue;
      }
      return { export: snapshot.export, job: jobResource(job) };
    }
    return null;
  }

  return {
    async createTranslationJob(input, idempotencyKey = null) {
      const { novelId, type, target } = requireObject(input);
      if (type !== 'translate_chapters') throw new ValidationError('job type must be translate_chapters');
      const canonicalTarget = canonicalizeChapterTarget(target);
      const existing = jobs.listJobs(novelId).find((job) => {
        if (job.type !== type) return false;
        if (idempotencyKey !== null) return job.idempotencyKey === idempotencyKey;
        return active(job) && canonicalizeChapterTarget(job.target).targetHash === canonicalTarget.targetHash;
      });
      if (existing) {
        if (canonicalizeChapterTarget(existing.target).targetHash !== canonicalTarget.targetHash) {
          throw new ConflictError('idempotency key was already used for a different job');
        }
        return { job: jobResource(existing), created: false };
      }
      const job = jobs.createTranslationJob({ novelId, target, idempotencyKey });
      await runner.wake();
      return { job: jobResource(job), created: true };
    },

    async createEpubExport({ novelId, selection }, idempotencyKey = null) {
      requireObject({ novelId, selection });
      canonicalizeChapterTarget(selection);
      database.exec('begin immediate');
      let result;
      try {
        const existing = existingEpubJob(novelId, selection, idempotencyKey);
        if (existing) {
          result = { ...existing, created: false };
        } else {
          const snapshot = exports.captureSnapshotInTransaction({ novelId, selection });
          const job = jobs.createBuildEpubJobInTransaction({ novelId, target: { exportId: snapshot.export.id }, idempotencyKey });
          const exportRecord = exports.attachBuildJobInTransaction({ novelId, exportId: snapshot.export.id, jobId: job.id });
          result = { export: exportRecord, job: jobResource(job), created: true };
        }
        database.exec('commit');
      } catch (error) {
        database.exec('rollback');
        throw error;
      }
      if (result.created) await runner.wake();
      return result;
    },

    getJobDetail({ novelId, jobId }) {
      return {
        job: jobResource(jobs.getJob({ novelId, jobId })),
        attempts: jobs.listJobAttempts({ novelId, jobId }),
        events: jobs.listJobEvents({ novelId, jobId })
      };
    },

    listJobs(novelId) {
      return jobs.listJobs(novelId).map(jobResource);
    },

    pause({ novelId, jobId }) {
      return jobResource(runner.pause({ novelId, jobId }));
    },

    async resume({ novelId, jobId }) {
      return jobResource(await runner.resume({ novelId, jobId }));
    }
  };
}
