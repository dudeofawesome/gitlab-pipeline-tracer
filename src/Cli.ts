import { Args, Command, Options } from '@effect/cli'
import { FileSystem } from '@effect/platform'
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
import type { JobFull } from './lib/fetch-data.js'
import { fetch_data } from './lib/fetch-data.js'
import { log_search } from './lib/log-search.js'
import { GitlabService } from './services/gitlab.js'

const command = Command.make(
  'generate',
  {
    sort: Options.choice(
      'sort',
      ['runner', 'name', 'time'] as const,
    ).pipe(Options.withDefault('name' as const)),
    generate_svg: Options.boolean('svg', {
      // aliases: ['g'],
      // negationNames: ['no-svg'],
    }).pipe(
      Options.withDefault(true),
      Options.withDescription(`generate SVG`),
    ),

    project_id: Args.text({ name: 'project ID' }),
    pipeline_id: Args.integer({ name: 'pipeline ID' }),
    job_id: Args.integer({ name: 'job ID' }).pipe(Args.optional),
  },
  ({ generate_svg, job_id, pipeline_id, project_id, sort }) =>
    Effect.gen(function*() {
      yield* Console.error(project_id, pipeline_id)

      const pipeline = yield* GitlabService.pipe(
        Effect.andThen((gitlab) =>
          gitlab.Pipelines.show(project_id, pipeline_id)
        ),
      )

      const jobs = yield* fetch_data({ project_id, job_id, pipeline_id })

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
          # displayMode: compact
          config:
            securityLevel: "loose"
            themeCSS: "
              #docker { fill: #1D63EC; stroke: #01298A; }
              #docker-text { fill: white; stroke: gray; }

              #git { fill: #F25037; stroke: #2F2708; }
              #git-text { fill: white; stroke: gray; }

              #npm { fill: #A01021; stroke: #872322; }
              #npm-text { fill: white; }

              #esbuild { fill: #FFCF02; stroke: #191919; }
              #esbuild-text { fill: black; stroke: gray; }

              #serverless { fill: #FD5850; stroke: #9B0902; }
              #serverless-text { fill: white; stroke: gray; }

              #next_build { fill: #000; stroke: #333; }
              #next_build-text { fill: white; stroke: gray; }
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

              // download artifacts
              log_search({
                name: 'artifacts',
                regex:
                  /^(?<start>.+?Z).*?section_start:\d+:download_artifacts$(?:.*\n)*?^(?<end>.+?Z).*?section_end:\d+:download_artifacts$/um,
                log: job._log,
              }),

              // npm install
              log_search({
                name: 'npm',
                regex:
                  /^(?<start>.+?Z) .+?\$ npm ci.+?\n(?:.*npm .*\n)+^(?<end>.+?Z) /um,
                log: job._log,
              }),

              // serverless build
              log_search({
                name: 'serverless',
                regex:
                  /^(?<start>.+?Z).*?> sls package.*?\n(?:.*[\n\r])*?^(?<end>.+?Z).*✔ Service packaged/um,
                log: job._log,
              }),

              // esbuild
              log_search({
                name: 'esbuild',
                regex:
                  /^(?<start>.+?Z).*?(?:node esbuild.mjs|> esbuild).*?\n(?:.*[\n\r])*?^(?<end>.+?Z).*⚡\s+.*Done in /um,
                log: job._log,
              }),

              // next build
              log_search({
                name: 'next_build',
                regex:
                  /^(?<start>.+?Z).*?> next build.*?\n(?:.*[\n\r])*?^(?<end>.+?Z).*prerendered as static content$/um,
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
              viewport: {
                width: 3000,
                height: 1000,
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

export const run = Command.run(command, {
  name: 'Hello World',
  version: '0.0.0',
})
