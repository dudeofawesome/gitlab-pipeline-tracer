import type { JobSchema } from '@gitbeaker/rest'
import { Array, DateTime, Effect, Option, pipe, String } from 'effect'
import type { Merge } from 'type-fest'
import { GitlabService } from '../services/gitlab.js'

export type JobFull = Merge<
  JobSchema,
  {
    _log: string
    runner: Merge<JobSchema['runner'], { version: Option.Option<string> }>
    started_at: Option.Some<DateTime.Utc>
    finished_at: Option.Some<DateTime.Utc>
  }
>

export function fetch_data({ job_id, pipeline_id, project_id }: {
  project_id: string
  pipeline_id: number
  job_id: Option.Option<number>
}) {
  return GitlabService.pipe(
    Effect.andThen((gitlab) =>
      gitlab.Jobs.all(project_id, {
        pipelineId: pipeline_id,
        pagination: 'offset',
      })
        .pipe(
          Effect.andThen((jobs) =>
            pipe(
              jobs,
              // enrich job data
              Array.map((job) =>
                Effect.gen(function*() {
                  const { finished_at, id, started_at } = job

                  const log = yield* gitlab.Jobs.showLog(project_id, id)

                  return {
                    ...job,

                    runner: {
                      ...job.runner,
                      version: pipe(
                        log,
                        String.match(
                          /^[^\n]*Running with gitlab-runner (?<version>\d+\.\d+\.\d+) \(/u,
                        ),
                        Option.andThen((match) =>
                          Option.fromNullable(match.groups?.version)
                        ),
                      ),
                    },

                    started_at: DateTime.make(started_at ?? NaN),
                    finished_at: DateTime.make(finished_at ?? NaN),

                    _log: log,
                  }
                })
              ),
              Effect.all,
              // filter out incomplete jobs
              Effect.map(
                Array.filter((job): job is JobFull =>
                  Option.isSome(job.started_at)
                  && Option.isSome(job.finished_at)
                  && job.runner != null
                ),
              ),
              // filter out non-specified jobs
              Effect.map(
                Array.filter((job) =>
                  Option.isSome(job_id) ? job.id === job_id.value : true
                ),
              ),
            )
          ),
        )
    ),
  )
}
