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
  Array,
  Config,
  Console,
  DateTime,
  Effect,
  Match,
  Option,
  pipe,
  Redacted,
} from 'effect'
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
    const pipeline_span = tracer.startSpan(`pipeline #${pipeline.id}`, {
      kind: SpanKind.SERVER,
      root: true,
      startTime: pipeline_start,
      attributes: {
        'project.id': pipeline.project_id,
        'pipeline.id': pipeline.id,
        'pipeline.url': pipeline.web_url,
      },
    })
    // pipeline_span.spanContext().traceId = `${pipeline.id}`
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
              'job.id': job.id,
              'job.name': job.name,
              'job.url': job.web_url,
              'job.queued_duration': job.queued_duration,
              'runner.id': job.runner.id,
              'runner.name': job.runner.name,
              'runner.version': Option.isSome(job.runner.version)
                ? job.runner.version.value
                : undefined,
            },
          },
          pipeline_ctx,
        )
        // job_span.spanContext().traceId = `${job.id}`
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
                  'step.name': task.name,
                  'step.logs': task.logs,
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
    yield* Console.error(
      `http://localhost:16686/trace/${pipeline_span.spanContext().traceId}`,
    )

    yield* Effect.tryPromise(() => provider.shutdown())

    yield* Console.error('Generated traces')
  },
)
