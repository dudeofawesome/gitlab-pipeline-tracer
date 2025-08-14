import type { FileSystem } from '@effect/platform'
import type { PlatformError } from '@effect/platform/Error'
import type { JobSchema } from '@gitbeaker/rest'
import { Array, DateTime, Effect, Option, pipe, String } from 'effect'
import type { UnknownException } from 'effect/Cause'
import type { ParseError } from 'effect/ParseResult'
import type { Merge } from 'type-fest'
import { GitlabService } from '../services/gitlab.js'
import type { Task } from './log-search.js'
import { log_search } from './log-search.js'

export type JobFull = Merge<
  JobSchema,
  {
    _log: string
    _spans: Array<Task>
    runner: Merge<JobSchema['runner'], { version: Option.Option<string> }>
    started_at: Option.Some<DateTime.Utc>
    finished_at: Option.Some<DateTime.Utc>
  }
>

export const fetch_data: (opts: {
  project_id: string
  pipeline_id: number
  job_id: Option.Option<number>
}) => Effect.Effect<
  Array<JobFull>,
  UnknownException | PlatformError | ParseError,
  GitlabService | FileSystem.FileSystem
> = Effect.fn('fetch_data')(
  function*({ job_id, pipeline_id, project_id }) {
    const gitlab = yield* GitlabService

    return yield* pipe(
      gitlab.Jobs.all(project_id, { pipelineId: pipeline_id }),
      // enrich job data
      Effect.andThen(Array.map((job) =>
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

            _spans: pipe(
              [
                // docker executor setup
                log_search({
                  name: 'docker',
                  regex:
                    /^(?<start>.+?Z) .+?Preparing the "docker" executor(?:.|\n)+?^(?<end>.+?Z) .+?Using docker image /um,
                  log,
                  job,
                }),

                // cloning
                log_search({
                  name: 'git',
                  regex:
                    /^(?<start>.+?Z).*?Getting source from Git repository.*?\n(?:.*\n)*?.*^(?<end>.+?Z).*?(?:Removing|section_end:)/um,
                  log,
                  job,
                }),

                // cleaning
                log_search({
                  name: 'rm',
                  regex:
                    /(?<log>^(?<start>.+?Z).*? Removing .*?\n(?:.*\n)*.+Removing.*)\n^(?<end>.+?Z)/um,
                  log,
                  job,
                }),

                // download artifacts
                log_search({
                  name: 'artifacts',
                  regex:
                    /^(?<start>.+?Z).*?section_start:\d+:download_artifacts$(?:.*\n)*?^(?<end>.+?Z).*?section_end:\d+:download_artifacts$/um,
                  log,
                  job,
                }),

                // apt-get
                log_search({
                  name: 'apt',
                  regex:
                    /^(?<start>.+?Z).*?apt-get[\s\-a-zA-Z]+update(?:.*\n)*.*(?:01E debconf|apt-get).*?\n^(?<end>.+?Z)/um,
                  log,
                  job,
                }),

                // npm install
                log_search({
                  name: 'npm',
                  regex:
                    /^(?<start>.+?Z) .+?\$ npm (?:ci|clean-install|install-clean)\b.+?\n(?:(?<final_npm>(?:.|\n)*^(?<end>.+?Z) npm (?!run))|(?<no_npm>^(?<end>.+?Z) ))/um,
                  log,
                  job,
                }),

                // serverless build
                log_search({
                  name: 'serverless',
                  regex:
                    /^(?<start>.+?Z).*?> sls package.*?\n(?:.*[\n\r])*?^(?<end>.+?Z).*✔ Service packaged/um,
                  log,
                  job,
                }),

                // esbuild
                log_search({
                  name: 'esbuild',
                  regex:
                    /^(?<start>.+?Z).*?(?:node esbuild.mjs|> esbuild).*?\n(?:.*[\n\r])*?^(?<end>.+?Z).*⚡\s+.*Done in /um,
                  log,
                  job,
                }),

                // next build
                log_search({
                  name: 'next_build',
                  regex:
                    /^(?<start>.+?Z).*?> next build.*?\n(?:.*[\n\r])*?^(?<end>.+?Z).*prerendered as static content$/um,
                  log,
                  job,
                }),

                // eslint
                log_search({
                  name: 'eslint',
                  regex:
                    /^(?<start>.+?Z) .*?.*\beslint\b.*?\n(?:.*\n)*^(?<end>.+?Z) .*\b(?:problems \(\d|.*\bNo problems found\b)/um,
                  log,
                  job,
                }),

                // upload artifacts
                log_search({
                  name: 'artifacts',
                  regex:
                    /^(?<start>.+?Z).*?section_start:\d+:upload_artifacts_on_success.*?\r(?:.*\n)*?.*^(?<end>.+?Z).*?section_end:\d+:upload_artifacts_on_success/um,
                  log,
                  job,
                }),

                // cleanup
                // log_search({
                //   name: 'cleanup',
                //   regex:
                //     /^(?<start>.+?Z).*?section_start:\d+:cleanup_file_variables.*?\r(?:.*\n)*?.*^(?<end>.+?Z).*?section_end:\d+:cleanup_file_variables/um,
                //   log,
                // }),

                // pre-"job succeeded"
                log_search({
                  name: 'wait',
                  regex:
                    // eslint-disable-next-line no-control-regex -- matching ESC char
                    /^(?<start>.+?Z).*?00O\+\[0K$.*?(?:.*\n)*?.*^(?<end>.+?Z).*?Job succeeded/um,
                  log,
                  job,
                }),
              ],
              Array.filterMap((span) => span),
            ),
          }
        })
      )),
      Effect.andThen(Effect.all),
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
  },
)
