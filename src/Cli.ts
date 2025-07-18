import { Args, Command, Options } from '@effect/cli'
import { FileSystem } from '@effect/platform'
import { Console, Effect, Match } from 'effect'
import { join } from 'path'
import { fetch_data } from './lib/fetch-data.js'
import { gantt } from './lib/gantt.js'
import { GitlabService } from './services/gitlab.js'

const parse = Command.make(
  'parse',
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
    no_cache: Options.boolean('no-cache').pipe(
      Options.withDefault(false),
    ),

    project_id: Args.text({ name: 'project ID' }),
    pipeline_id: Args.integer({ name: 'pipeline ID' }),
    job_id: Args.integer({ name: 'job ID' }).pipe(Args.optional),
  },
  ({ generate_svg, job_id, no_cache, output, pipeline_id, project_id, sort }) =>
    Effect.gen(function*() {
      yield* Console.error(project_id, pipeline_id)

      if (no_cache) {
        yield* FileSystem.FileSystem.pipe(
          Effect.andThen((fs) =>
            fs.remove(join('.cache', 'gitlab'), { recursive: true })
          ),
          Effect.catchTag('SystemError', () => Effect.void),
        )
      }

      const pipeline = yield* GitlabService.pipe(
        Effect.andThen((gitlab) =>
          gitlab.Pipelines.show(project_id, pipeline_id)
        ),
      )

      const jobs = yield* fetch_data({ project_id, job_id, pipeline_id })

      yield* Match.value(output).pipe(
        Match.when(
          'gantt',
          () => gantt({ generate_svg, jobs, pipeline, pipeline_id, sort }),
        ),
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
