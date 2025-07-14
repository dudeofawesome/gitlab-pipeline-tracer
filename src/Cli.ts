import { Args, Command, Options } from '@effect/cli'
import { Command as ShellCommand, FileSystem } from '@effect/platform'
import type { JobSchema } from '@gitbeaker/rest'
import { Gitlab } from '@gitbeaker/rest'
import { run as mermaid } from '@mermaid-js/mermaid-cli'
import { stripIndent } from 'common-tags'
import {
  Array,
  Console,
  DateTime,
  Duration,
  Effect,
  Match,
  Number,
  Option,
  Order,
  pipe,
  String,
} from 'effect'
import type { Merge } from 'type-fest'

type JobFull = Merge<
  JobSchema,
  {
    _log: string
    runner: Merge<JobSchema['runner'], { version: Option.Option<string> }>
    started_at: Option.Some<DateTime.Utc>
    finished_at: Option.Some<DateTime.Utc>
  }
>

const command = Command.make(
  'hello',
  {
    project_id: Args.text({ name: 'project ID' }),
    pipeline_id: Args.integer({ name: 'pipeline ID' }),
    job_id: Args.integer({ name: 'job ID' }).pipe(Args.optional),
    sort: Options.choice(
      'sort',
      ['runner', 'name', 'time'] as const,
    ).pipe(Options.withDefault('name' as const)),
    generate_svg: Options.boolean('svg').pipe(
      Options.withDefault(true),
      Options.withDescription(`generate SVG`),
    ),
  },
  ({ generate_svg, job_id, pipeline_id, project_id, sort }) =>
    Effect.gen(function*() {
      yield* Console.error(project_id, pipeline_id)

      const gitlab_token = yield* ShellCommand.string(
        ShellCommand.make(
          'op',
          'item',
          'get',
          'GitLab Personal Access Token',
          '--fields',
          'token',
          '--reveal',
        ),
      )
      const gitlab = yield* Effect.try(() =>
        new Gitlab({
          host: 'https://gitlabdev.paciolan.info',
          token: gitlab_token,
        })
      )

      const pipeline = yield* Effect.tryPromise(() =>
        gitlab.Pipelines.show(project_id, pipeline_id)
      )
      const jobs = yield* Effect.tryPromise(() =>
        gitlab.Jobs.all(project_id, { pipelineId: pipeline_id })
      ).pipe(
        Effect.andThen((jobs) =>
          pipe(
            jobs,
            // enrich job data
            Array.map((job) =>
              Effect.gen(function*() {
                const { finished_at, id, started_at } = job

                const log = yield* Effect.tryPromise(() =>
                  gitlab.Jobs.showLog(project_id, id)
                )

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

      const sorter = Match.value(sort).pipe(
        Match.when('name', () =>
          Array.sort(
            pipe(
              String.Order,
              Order.mapInput(({ name }: JobFull) => name),
            ),
          )),
        Match.when('time', () =>
          Array.sort(
            pipe(
              DateTime.Order,
              Order.mapInput(({ started_at }: JobFull) => started_at.value),
            ),
          )),
        Match.when('runner', () =>
          Array.sort(
            pipe(
              Number.Order,
              Order.mapInput(({ runner: { id } }: JobFull) => id ?? 0),
            ),
          )),
        Match.exhaustive,
      )

      const gantt_mmd = [
        stripIndent`
          ---
          theme: default
          displayMode: compact
          config:
            securityLevel: "loose"
            themeCSS: "
              #docker { fill: #1D63EC; stroke: #01298A; }
              #docker-text { fill: white; stroke: black; }

              #git { fill: #F25037; stroke: #2F2708; }
              #git-text { fill: white; }

              #npm { fill: #A01021; stroke: #872322; }
              #npm-text { fill: white; }

              #next_build { fill: #000; stroke: #333; }
              #next_build-text { fill: white; stroke: black; }
            "
            gantt:
              topAxis: true
          ---
        `,
        stripIndent`
          %% ${pipeline.web_url}
        `,
        stripIndent`
          gantt
            title ${pipeline.name ?? pipeline.ref}
            dateFormat x
            %% axisFormat %X
            axisFormat %H:%M
            tickInterval 2minute
        `,
        '',
        pipe(
          jobs,
          sorter,
          Array.map((job) => {
            const slug = pipe(
              job.name,
              String.replaceAll(':', ' '),
              String.replaceAll(/\s+/giu, '_'),
            )
            return [
              `section ${
                [
                  job.name,
                  job.runner.id != null ? `runner #${job.runner.id}` : null,
                  Option.isSome(job.runner.version)
                    ? `  v${job.runner.version.value}`
                    : null,
                  // job.runner.description,
                ].filter((l) => Boolean(l)).join('<br>')
              }`,

              [
                [
                  `job`,
                  `(${
                    DateTime.distanceDuration(
                      job.started_at.value,
                      job.finished_at.value,
                    )
                      .pipe(Duration.toMinutes, Number.round(1))
                  }m)`,
                  `:${slug}`,
                ].join(' '),
                job.started_at.value.pipe(DateTime.toEpochMillis),
                job.finished_at.value.pipe(DateTime.toEpochMillis),
              ].join(', '),
              `click ${slug} href "${job.web_url}"`,

              // docker executor setup
              log_search({
                name: 'docker',
                regex:
                  /^(?<start>.+?Z) .+?Preparing the "docker" executor(?:.|\n)+?^(?<end>.+?Z) .+?Using docker image /um,
                log: job._log,
              }),

              // cloning
              log_search({
                name: 'git',
                regex:
                  /^(?<start>.+?Z).*?Getting source from Git repository.*?\n(?:.*\n)*?.*^(?<end>.+?Z).*?(?:Removing|section_end:)/um,
                log: job._log,
              }),

              // cleaning
              log_search({
                name: 'rm',
                regex:
                  /^(?<start>.+?Z).*? Removing .*?\n(?:.*\n)*.+Removing.*\n^(?<end>.+?Z)/um,
                log: job._log,
              }),

              // npm install
              log_search({
                name: 'npm',
                regex:
                  /^(?<start>.+?Z) .+?\$ npm ci.+?\n(?:.*npm .*\n)+^(?<end>.+?Z) /um,
                log: job._log,
              }),

              // next build
              log_search({
                name: 'next_build',
                regex:
                  /^(?<start>.+?Z).*?> next build.*?\n(?:.*\n)*?.*prerendered as static content.*\r^(?<end>.+?Z)/um,
                log: job._log,
              }),

              // upload artifacts
              log_search({
                name: 'artifacts',
                regex:
                  /^(?<start>.+?Z).*?section_start:\d+:upload_artifacts_on_success.*?\r(?:.*\n)*?.*^(?<end>.+?Z).*?section_end:\d+:upload_artifacts_on_success/um,
                log: job._log,
              }),
            ].filter((l) => Boolean(l)).join('\n')
          }),
          Array.join('\n\n'),
        ),
      ].join('\n')

      const fs = yield* FileSystem.FileSystem
      const filename = 'gantt.mmd'
      yield* fs.writeFileString(filename, gantt_mmd).pipe(
        Effect.tap(Console.error('generated mmd')),
      )

      if (generate_svg) {
        yield* Effect.tryPromise(() =>
          mermaid(filename, 'gantt.svg', {
            parseMMDOptions: {
              mermaidConfig: {
                'securityLevel': 'loose',
              },
            },
          })
        ).pipe(
          Effect.tap(Console.error('rendered svg')),
        )
      }

      yield* Console.error('done')
    }),
)

function log_search(
  { log, name, regex, tag = name }: {
    name: string
    tag?: string
    regex: RegExp
    log: string
  },
) {
  return pipe(
    log,
    String.match(
      regex,
    ),
    // (str) => Option.fromNullable(str.match(regex)),
    Option.andThen(({ groups }) =>
      Option.all({
        start: DateTime.make(groups?.start ?? ''),
        end: DateTime.make(groups?.end ?? ''),
      })
    ),
    Option.map(({ end, start }) => {
      const dur = DateTime.distanceDuration(start, end)
      // build task
      return [
        [
          name,
          dur.pipe(Duration.greaterThan(Duration.seconds(30)))
            ? `(${dur.pipe(Duration.toMinutes, (n) => n.toFixed(1))}m)`
            : '',
          `:${tag}`,
        ]
          .join(' '),
        start.pipe(DateTime.toEpochMillis),
        end.pipe(DateTime.toEpochMillis),
      ].join(', ')
    }),
    // Option.orElse(() => Option.some('')),
    (opt) => {
      if (Option.isNone(opt)) {
        console.log(name, log)
      }
      return opt
    },
    (opt) => Option.isSome(opt) ? opt.value : '',
  )
}

export const run = Command.run(command, {
  name: 'Hello World',
  version: '0.0.0',
})
