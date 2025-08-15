import { FileSystem } from '@effect/platform'
import type { PlatformError } from '@effect/platform/Error'
import type { JobSchema, PipelineSchema, ProjectSchema } from '@gitbeaker/rest'
import { Gitlab } from '@gitbeaker/rest'
import { Context, Effect, Layer, Match, pipe, Schema as S } from 'effect'
import type { UnknownException } from 'effect/Cause'
import type { ParseError } from 'effect/ParseResult'
import { dirname, join } from 'path'
import type { Simplify } from 'type-fest'
import { OnePasswordService } from './1password.js'

type gitlab = Simplify<(typeof Gitlab)['prototype']>

export class GitlabService extends Context.Tag('GitlabService')<
  GitlabService,
  {
    Projects: {
      show: (
        project_id_or_path: string | number,
      ) => Effect.Effect<
        ProjectSchema,
        UnknownException | PlatformError | ParseError,
        FileSystem.FileSystem
      >
    }
    Pipelines: {
      show: (
        // ...args: Parameters<gitlab['Pipelines']['show']>
        project_id: string | number,
        pipeline_id: number,
      ) => Effect.Effect<
        // Awaited<ReturnType<gitlab['Pipelines']['show']>>,
        PipelineSchema,
        UnknownException | PlatformError | ParseError,
        FileSystem.FileSystem
      >
    }
    Jobs: {
      all: (
        ...args: Parameters<gitlab['Jobs']['all']>
      ) => Effect.Effect<
        // Awaited<ReturnType<gitlab['Jobs']['all']>>,
        Array<JobSchema>,
        UnknownException | PlatformError | ParseError,
        FileSystem.FileSystem
      >
      show: (
        ...args: Parameters<gitlab['Jobs']['show']>
      ) => Effect.Effect<
        Awaited<ReturnType<gitlab['Jobs']['show']>>,
        UnknownException | PlatformError | ParseError,
        FileSystem.FileSystem
      >
      showLog: (
        ...args: Parameters<gitlab['Jobs']['showLog']>
      ) => Effect.Effect<
        // Awaited<ReturnType<gitlab['Jobs']['showLog']>>,
        string,
        UnknownException | PlatformError | ParseError,
        FileSystem.FileSystem
      >
    }
  }
>() {}

export const GitlabServiceLive = Layer.effect(
  GitlabService,
  Effect.gen(function*() {
    const { host, token } = yield* OnePasswordService
      .pipe(
        Effect.andThen((op) =>
          op.getFields('GitLab Personal Access Token', {
            fields: { label: ['host', 'token'] },
          }).pipe(
            Effect.map(([{ value: host }, { value: token }]) => ({
              host: host.startsWith('http') ? host : `https://${host}`,
              token,
            })),
            Effect.catchTag('@1password/op-js/CLIError', (err) =>
              Match.value(err).pipe(
                Match.when({
                  cause: {
                    cause: {
                      message: (msg: string) =>
                        msg.includes(
                          `RequestDelegatedSession: cannot setup session.`,
                        ),
                    },
                  },
                }, () =>
                  Effect.succeed({ host: 'https://gitlab.com', token: '' })),
                Match.orElse((err) =>
                  err
                ),
              )),
          )
        ),
      )

    const gitlab = yield* Effect.try(() => new Gitlab({ host, token }))

    return {
      Projects: {
        show(projectIdOrPath) {
          return cache({
            fetcher: () => gitlab.Projects.show(projectIdOrPath),
            path: join(
              '.cache',
              'gitlab',
              'projects',
              `${projectIdOrPath.toString().replaceAll('/', '+')}.json`,
            ),
          })
        },
      },
      Pipelines: {
        show(projectId, pipelineId) {
          return cache({
            fetcher: () => gitlab.Pipelines.show(projectId, pipelineId),
            path: join('.cache', 'gitlab', 'pipelines', `${pipelineId}.json`),
          })
        },
      },
      Jobs: {
        all(projectId, args_1) {
          return cache({
            fetcher: () =>
              gitlab.Jobs.all<false, 'offset'>(projectId, {
                ...args_1,
                showExpanded: false,
                pagination: 'offset',
              }),
            path: join(
              '.cache',
              'gitlab',
              'pipelines',
              `${args_1?.pipelineId}-jobs.json`,
            ),
          })
        },
        show(projectId, jobId, options) {
          return cache({
            fetcher: () =>
              gitlab.Jobs.show<false>(projectId, jobId, {
                ...options,
                showExpanded: false,
              }),
            path: join('.cache', 'gitlab', 'jobs', `${jobId}.json`),
          })
        },
        showLog(projectId, jobId, options) {
          return cache({
            fetcher: () =>
              gitlab.Jobs.showLog<false>(projectId, jobId, {
                ...options,
                showExpanded: false,
              }),
            schema: S.String,
            path: join('.cache', 'gitlab', 'jobs', `${jobId}.log`),
          })
        },
      },
    }
  }),
)

const cache = Effect.fn('cache')(
  function*<Output = string>(
    {
      fetcher,
      path,
      schema = S.parseJson(S.Any, { space: 2 }),
    }: {
      path: string
      fetcher: () => Promise<Output>
      schema?: S.Schema<Output, string>
    },
  ) {
    const fs = yield* FileSystem.FileSystem

    return yield* pipe(
      fs.access(path),
      Effect.andThen(fs.readFileString(path)),
      Effect.andThen(S.decode(schema, { errors: 'all' })),
    ).pipe(
      Effect.catchAll(() =>
        Effect.tryPromise(fetcher).pipe(Effect.tap((data) =>
          pipe(
            S.encode(schema, { errors: 'all' })(data),
            Effect.tap(fs.makeDirectory(dirname(path), { recursive: true })),
            Effect.andThen((encoded) => fs.writeFileString(path, encoded)),
          )
        ))
      ),
    )
  },
)
