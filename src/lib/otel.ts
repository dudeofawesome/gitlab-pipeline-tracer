import { Url } from '@effect/platform'
import type { PipelineSchema } from '@gitbeaker/rest'
import {
  context,
  diag,
  DiagConsoleLogger,
  DiagLogLevel,
  SpanKind,
  SpanStatusCode,
  trace,
  TraceFlags,
} from '@opentelemetry/api'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node'
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions'
import {
  ATTR_CICD_PIPELINE_NAME,
  ATTR_CICD_PIPELINE_RESULT,
  ATTR_CICD_PIPELINE_RUN_ID,
  ATTR_CICD_PIPELINE_RUN_URL_FULL,
  ATTR_CICD_PIPELINE_TASK_NAME,
  ATTR_CICD_PIPELINE_TASK_RUN_ID,
  ATTR_CICD_PIPELINE_TASK_RUN_RESULT,
  ATTR_CICD_PIPELINE_TASK_RUN_URL_FULL,
  ATTR_CICD_WORKER_ID,
  ATTR_CICD_WORKER_NAME,
  ATTR_CICD_WORKER_URL_FULL,
  ATTR_SERVICE_NAMESPACE,
  ATTR_URL_TEMPLATE,
} from '@opentelemetry/semantic-conventions/incubating'
import type { ConfigError } from 'effect'
import {
  Array,
  Config,
  Console,
  DateTime,
  Effect,
  Either,
  Match,
  Option,
  pipe,
  Redacted,
} from 'effect'
import {
  ATTR_CICD_PIPELINE_TASK_STARTED_BY_ID,
  ATTR_CICD_PIPELINE_TASK_STARTED_BY_NAME,
  ATTR_CICD_PIPELINE_TASK_STEP_ADJUSTED_START_TS,
  ATTR_CICD_PIPELINE_TASK_STEP_LOGS,
  ATTR_CICD_PIPELINE_TASK_STEP_NAME,
  ATTR_CICD_WORKER_IP_ADDRESS,
  ATTR_CICD_WORKER_TYPE,
  ATTR_CICD_WORKER_VERSION,
  ATTR_GITLAB_PROJECT_ID,
} from './attributes.js'
import type { JobFull } from './fetch-data.js'

export const otel = Effect.fn('otel')(
  function*({ jobs, pipeline, trace_dest }: {
    jobs: Array<JobFull>
    pipeline: PipelineSchema
    trace_dest: 'swo' | 'local'
  }) {
    diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN)

    const exporter = yield* Match.value(trace_dest).pipe(
      Match.when('local', () =>
        Effect.succeed(
          new OTLPTraceExporter({
            url: `http://localhost:4318/v1/traces`,
          }),
        )),
      Match.when('swo', () =>
        Effect.gen(function*() {
          return new OTLPTraceExporter({
            url: `https://otel.collector.na-01.cloud.solarwinds.com/v1/traces`,
            headers: {
              authorization: `Bearer ${yield* Config.redacted(
                'SWO_TELEMETRY_AUTH_TOKEN',
              ).pipe(Effect.map(Redacted.value))}`,
            },
          })
        })),
      Match.exhaustive,
    )

    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAMESPACE]: 'gitlab',
      [ATTR_SERVICE_NAME]: 'gitlab pipelines',
    })
    const provider = new NodeTracerProvider({
      resource,
      spanProcessors: [
        new BatchSpanProcessor(exporter),
        // new SimpleSpanProcessor(new ConsoleSpanExporter()),
        // {
        //   forceFlush: async () => {},
        //   onStart: (_span, _parentContext) => {},
        //   onEnd: (span) => {
        //     const sampled =
        //       !!(span.spanContext().traceFlags & TraceFlags.SAMPLED)
        //     console.log(`span sampled: ${sampled}`)
        //   },
        //   shutdown: async () => {},
        // },
      ],
    })
    provider.register({})
    const tracer = trace.getTracer(`project #${pipeline.project_id}`)

    const pipeline_start = DateTime.unsafeMake(pipeline.created_at).pipe(
      DateTime.toEpochMillis,
    )
    const pipeline_name = `pipeline #${pipeline.id}`
    const pipeline_span = tracer.startSpan(pipeline_name, {
      kind: SpanKind.SERVER,
      root: true,
      startTime: pipeline_start,
      attributes: {
        [ATTR_GITLAB_PROJECT_ID]: pipeline.project_id,
        [ATTR_CICD_PIPELINE_NAME]: pipeline.ref,
        [ATTR_CICD_PIPELINE_RUN_ID]: pipeline.id,
        [ATTR_CICD_PIPELINE_RUN_URL_FULL]: pipeline.web_url,
        [ATTR_CICD_PIPELINE_RESULT]: pipeline.status,
      },
    })
    // OTel trace IDs must be 32-character hexadecimal strings.
    pipeline_span.spanContext().traceId = pipeline.id.toString().padEnd(32, '0')

    if (pipeline.status !== 'success') {
      pipeline_span.setStatus({ code: SpanStatusCode.ERROR })
    }
    const pipeline_ctx = trace.setSpan(context.active(), pipeline_span)

    let pipeline_end: number = pipeline_start

    pipe(
      jobs,
      Array.forEach((job) => {
        const job_span = tracer.startSpan(
          `${job.name} #${job.id}`,
          {
            startTime: job.started_at.value.pipe(DateTime.toEpochMillis),
            attributes: {
              [ATTR_CICD_PIPELINE_TASK_RUN_ID]: job.id,
              [ATTR_CICD_PIPELINE_TASK_NAME]: job.name,
              [ATTR_CICD_PIPELINE_TASK_RUN_URL_FULL]: job.web_url,
              [ATTR_CICD_PIPELINE_TASK_STARTED_BY_ID]: job.user.id,
              [ATTR_CICD_PIPELINE_TASK_STARTED_BY_NAME]: job.user.name,
              [ATTR_CICD_PIPELINE_TASK_RUN_RESULT]: job.status,
              'job.queued_duration_s': job.queued_duration,
              [ATTR_CICD_WORKER_ID]: job.runner.id,
              [ATTR_CICD_WORKER_NAME]: job.runner.name,
              [ATTR_CICD_WORKER_VERSION]: Option.isSome(job.runner.version)
                ? job.runner.version.value
                : undefined,
              [ATTR_CICD_WORKER_URL_FULL]: pipe(
                job.pipeline.web_url,
                Url.fromString,
                Either.map((url) =>
                  Url.setPathname(url, `groups/${url.pathname}`)
                ),
                Either.map((url) =>
                  Url.setPathname(
                    url,
                    url.pathname.replace(/\/[^/]+\/-\/pipelines\/\d+$/, ''),
                  )
                ),
                Either.map((url) =>
                  Url.setPathname(
                    url,
                    `${url.pathname}/-/runners/${job.runner.id}`,
                  )
                ),
                (res) => Either.isRight(res) ? res.right.toString() : undefined,
              ),
              [ATTR_CICD_WORKER_TYPE]: job.runner.runner_type,
              [ATTR_CICD_WORKER_IP_ADDRESS]: job.runner.ip_address,
            },
          },
          pipeline_ctx,
        )
        job_span.spanContext().spanId = job.id.toString().padEnd(16, '0')
        if (job.status !== 'success') {
          job_span.setStatus({
            code: SpanStatusCode.ERROR,
            ...(job.failure_reason != null
              ? { message: job.failure_reason }
              : {}),
          })
        }
        const job_ctx = trace.setSpan(pipeline_ctx, job_span)

        pipe(
          job._spans,
          Array.forEach((task) => {
            const task_span = tracer.startSpan(
              task.name,
              {
                kind: SpanKind.CLIENT,
                startTime: task.start.pipe(DateTime.toEpochMillis),
                attributes: {
                  [ATTR_CICD_PIPELINE_TASK_STEP_NAME]: task.name,
                  [ATTR_CICD_PIPELINE_TASK_STEP_LOGS]: task.logs,
                  [ATTR_CICD_PIPELINE_TASK_STEP_ADJUSTED_START_TS]:
                    task.fixed_start,
                },
              },
              job_ctx,
            )
            task_span.end(task.end.pipe(DateTime.toEpochMillis))
          }),
        )

        const job_end = job.finished_at.value.pipe(DateTime.toEpochMillis)
        if (job_end > pipeline_end) pipeline_end = job_end
        job_span.end(job_end)
      }),
    )

    pipeline_span.end(pipeline_end)

    yield* Console.error(
      `Sending trace ${pipeline_span.spanContext().traceId} to ${trace_dest}`,
    )
    yield* Match.value(trace_dest).pipe(
      Match.withReturnType<Effect.Effect<void, ConfigError.ConfigError>>(),
      Match.when('local', () =>
        Console.error(
          `http://localhost:16686/trace/${pipeline_span.spanContext().traceId}`,
        )),
      Match.when(
        'swo',
        () =>
          Effect.gen(function*() {
            return yield* Console.error(
              `https://my.na-01.cloud.solarwinds.com/${yield* Config.string(
                'SWO_ACCOUNT_ID',
              )}/traces/${pipeline_span.spanContext().traceId}/details/breakdown`,
            )
          }),
      ),
      Match.orElse(() => Effect.void),
    )

    yield* Effect.tryPromise(() => provider.shutdown())

    yield* Console.error('Generated traces')
  },
)
