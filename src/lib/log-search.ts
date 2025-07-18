import { DateTime, Duration, Option, pipe, String } from 'effect'

export function log_search(
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
    (opt) => Option.isSome(opt) ? opt.value : '',
  )
}
