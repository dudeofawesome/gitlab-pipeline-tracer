import type { JobSchema } from '@gitbeaker/rest'
import {
  Console,
  DateTime,
  Effect,
  Iterable,
  Option,
  pipe,
  String,
} from 'effect'

export interface Task {
  name: string
  start: DateTime.Utc
  end: DateTime.Utc
  logs: string
  fixed_start: boolean
}

export function log_search(
  { job, log, name, regex }: {
    name: string
    regex: RegExp
    log: string
    job: JobSchema
  },
): Option.Option<Task> {
  return pipe(
    log,
    String.match(regex),
    Option.andThen((match) =>
      Option.all({
        name: Option.some(name),
        start: DateTime.make(match.groups?.start ?? ''),
        end: DateTime.make(match.groups?.end ?? ''),
        logs: Option.fromNullable(match.groups?.logs ?? match[0]),
        fixed_start: Option.some(false),
      })
    ),
    Option.andThen((task) => {
      if (task.end.pipe(DateTime.lessThanOrEqualTo(task.start))) {
        // yield* Console.warn(
        //   `${task.name} of ${job.name} #${job.id} started before it ended. This seems to be caused by a log timestamp error? Using the first timestamp from a log that is before the end.`,
        // )
        const matches = task.logs.matchAll(
          /^(?<date>\d{4,}-\d{2}-\d{2}T\d{1,2}:\d{2}:\d{2}(?:\.\d+)Z)\b/umg,
        )

        const start = pipe(
          matches,
          Iterable.findFirst(({ groups }) => {
            if (groups?.date == null) return Option.none()

            const date = DateTime.unsafeMake(groups.date)
            if (date.pipe(DateTime.lessThanOrEqualTo(task.end))) {
              return Option.some(date)
            }

            return Option.none()
          }),
          // Option.orElseSome(() => task.end),
        )

        return {
          ...task,
          start: Option.isSome(start) ? start.value : task.end,
          fixed_timestamp: true,
        }
      }

      return task
    }),
  )
}
