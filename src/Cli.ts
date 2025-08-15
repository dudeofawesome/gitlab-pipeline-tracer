import { Args, Command, Options } from '@effect/cli'
import { FileSystem } from '@effect/platform'
import { Console, Effect, Match } from 'effect'
import { join } from 'path'
import { fetch_data } from './lib/fetch-data.js'
import { gantt } from './lib/gantt.js'
import { otel } from './lib/otel.js'
import { GitlabService } from './services/gitlab.js'

const parse = Command.make(
  'parse',
  {
    output: Options.choice(
      'output',
      ['gantt', 'otel'] as const,
    ).pipe(Options.withDefault('gantt' as const)),
    trace_dest: Options.choice(
      'trace-dest',
      ['local', 'swo'] as const,
    ).pipe(Options.withDefault('local' as const)),
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
    no_cache: Options.boolean('no-cache').pipe(
      Options.withDefault(false),
    ),

    project_id_or_path: Args.text({ name: 'project ID / path' }).pipe(
      Args.withDescription(`The project's ID or path`),
    ),
    pipeline_id: Args.integer({ name: 'pipeline ID' }),
    job_id: Args.integer({ name: 'job ID' }).pipe(Args.optional),
  },
  (
    {
      generate_svg,
      job_id,
      no_cache,
      output,
      pipeline_id,
      project_id_or_path,
      sort,
      trace_dest,
    },
  ) =>
    Effect.gen(function*() {
      const gitlab = yield* GitlabService

      const project_id = (project_id_or_path.match(/^\d+$/u)) ?
        project_id_or_path :
        yield* gitlab.Projects.show(project_id_or_path).pipe(
          Effect.map((project) => project.id.toString()),
        )

      yield* Console.error({ project_id, pipeline_id })

      if (no_cache) {
        yield* FileSystem.FileSystem.pipe(
          Effect.andThen((fs) =>
            fs.remove(join('.cache', 'gitlab'), { recursive: true })
          ),
          Effect.catchTag('SystemError', () => Effect.void),
        )
      }

      const pipeline = yield* gitlab.Pipelines.show(project_id, pipeline_id)

      const jobs = yield* fetch_data({ project_id, job_id, pipeline_id })

      yield* Match.value(output).pipe(
        Match.when(
          'gantt',
          () => gantt({ generate_svg, jobs, pipeline, pipeline_id, sort }),
        ),
        Match.when(
          'otel',
          () => otel({ jobs, pipeline, trace_dest }),
        ),
        Match.exhaustive,
      )

      yield* Console.error('done')
    }),
)

export const run = Command.run(parse, {
  name: 'gitlab-pipeline-visualizer',
  version: '0.0.0',
})
