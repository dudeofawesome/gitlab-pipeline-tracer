import { DateTime, Option, pipe, String } from 'effect'

export function log_search(
  { log, name, regex }: { name: string; regex: RegExp; log: string },
) {
  return pipe(
    log,
    String.match(regex),
    Option.andThen((match) =>
      Option.all({
        name: Option.some(name),
        start: DateTime.make(match.groups?.start ?? ''),
        end: DateTime.make(match.groups?.end ?? ''),
        logs: Option.fromNullable(match.groups?.logs ?? match[0]),
      })
    ),
  )
}
