import { FileSystem } from '@effect/platform'
import type { PipelineSchema } from '@gitbeaker/rest'
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
import type { JobFull } from './fetch-data.js'

export const gantt = Effect.fn('gantt')(
  function*({ generate_svg, jobs, pipeline, pipeline_id, sort }: {
    generate_svg: boolean
    jobs: Array<JobFull>
    pipeline: PipelineSchema
    pipeline_id: number
    sort: 'name' | 'time' | 'runner'
  }) {
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

    function deploy_marker(
      jobs: Array<JobFull>,
      env: 'dev' | 'qfnq' | 'prod',
    ): Option.Option<string> {
      return pipe(
        jobs,
        Array.filter((job) => job.name.startsWith(`${env}/`)),
        Array.sort(
          pipe(
            DateTime.Order,
            Order.mapInput(({ started_at }: JobFull) => started_at.value),
          ),
        ),
        (jobs) => Option.fromNullable(jobs?.[0]?.started_at?.value),
        (foo) => {
          return foo
        },
        Option.map((started_at) =>
          `deploy ${env} : vert, ${started_at.pipe(DateTime.toEpochMillis)}, 0m`
        ),
      )
    }

    const gantt_mmd = yield* pipe(
      [
        Option.some(stripIndent`
          ---
          theme: default
          displayMode: compact
          config:
            securityLevel: "loose"
            themeCSS: "
              #docker { fill: #1D63EC; stroke: #01298A; }
              #docker-text { fill: white; stroke: gray; }

              #git { fill: #F25037; stroke: #2F2708; }
              #git-text { fill: white; stroke: gray; }

              #apt { fill: #A80031; stroke: #E9541F; }
              #apt-text { fill: white; stroke: gray; }

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
        `),
        Option.some(stripIndent`
          %% ${pipeline.web_url}
        `),
        Option.some(stripIndent`
          gantt
            title ${pipeline.name ?? pipeline.ref}
            dateFormat x
            %% axisFormat %X
            axisFormat %H:%M
            tickInterval 2minute
        `),
        Option.some(''),

        deploy_marker(jobs, 'dev'),
        deploy_marker(jobs, 'qfnq'),
        deploy_marker(jobs, 'prod'),

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
                  `job #${job.id}`,
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

              pipe(job._spans, Array.map(job_to_task), Array.join('\n')),
            ].filter((l) => Boolean(l)).join('\n')
          }),
          Array.join('\n\n'),
          Option.some,
        ),
      ],
      Array.filter(Option.isSome),
      Option.all,
      Option.map(Array.join('\n')),
    )

    const fs = yield* FileSystem.FileSystem
    const filename = `gantt-${pipeline_id}.mmd`
    yield* fs.writeFileString(filename, gantt_mmd).pipe(
      Effect.tap(Console.error('generated mmd')),
    )

    if (generate_svg) {
      yield* Effect.tryPromise(() =>
        mermaid(filename, `gantt-${pipeline_id}.svg`, {
          parseMMDOptions: {
            mermaidConfig: {
              'securityLevel': 'loose',
            },
            viewport: {
              width: 2000,
              height: 1000,
            },
          },
        })
      ).pipe(
        Effect.tap(Console.error('rendered svg')),
      )
    }
  },
)

function job_to_task(
  { name, tag = name, start, end }: {
    name: string
    tag?: string
    start: DateTime.Utc
    end: DateTime.Utc
  },
) {
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
}
