import { DateTime, Option, pipe, String } from 'effect'

export function log_search(
  { log, name, regex }: { name: string; regex: RegExp; log: string },
) {
  return pipe(
    log,
    String.match(regex),
    Option.andThen(({ groups }) =>
      Option.all({
        name: Option.some(name),
        start: DateTime.make(groups?.start ?? ''),
        end: DateTime.make(groups?.end ?? ''),
      })
    ),
  )
}
