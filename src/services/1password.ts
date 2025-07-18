import {
  type CLIError as OriginalCLIError,
  type FieldLabelSelector,
  type Item,
  item,
  validateCli,
  type ValueField,
} from '@1password/op-js'
import { Context, Effect, Effect as E, Layer } from 'effect'
import type { UnknownException } from 'effect/Cause'
import { TaggedError } from 'effect/Data'

export class CLIError extends TaggedError('@1password/op-js/CLIError')<{
  cause: OriginalCLIError
}> {}

export class UnsupportedFlags
  extends TaggedError('@1password/op-js/UnsupportedFlags')<{
    flags: FieldLabelSelector
  }>
{}

export class CLIInvalidError
  extends TaggedError('@1password/op-js/CLIInvalidError')<{ cause: unknown }>
{}

export type GetReturn =
  | ValueField
  | Item
  | Array<ValueField>

export class OnePasswordService extends Context.Tag('@1password/op')<
  OnePasswordService,
  {
    // get(
    //   name: string,
    //   flags?: {
    //     vault?: string
    //     includeArchive?: boolean
    //   },
    // ): E.Effect<Item, CLIError>
    // get(
    //   name: string,
    //   flags: {
    //     fields: { label: [string] } // satisfies FieldLabelSelector
    //     vault?: string
    //     includeArchive?: boolean
    //   },
    // ): E.Effect<ValueField, CLIError>
    // get(
    //   name: string,
    //   flags: {
    //     fields: { label: [string, ...Array<string>] } // satisfies FieldLabelSelector
    //     vault?: string
    //     includeArchive?: boolean
    //   },
    // ): E.Effect<Array<ValueField>, CLIError>
    getItem(
      name: string,
      flags?: {
        vault?: string
        includeArchive?: boolean
      },
    ): E.Effect<Item, CLIError>
    getFields(
      name: string,
      flags: {
        fields: FieldLabelSelector
        vault?: string
        includeArchive?: boolean
      },
    ): E.Effect<Array<ValueField>, CLIError>
  }
>() {}

export const OnePasswordServiceLive = Layer.effect(
  OnePasswordService,
  Effect.gen(function*() {
    yield* Effect.tryPromise(() => validateCli('>=2')).pipe(
      Effect.catchTag(
        'UnknownException',
        (err) => E.fail(new CLIInvalidError({ cause: err })),
      ),
    )

    const handle_error = E.catchAll((err: UnknownException) => {
      if (
        err.cause != null &&
        typeof err.cause === 'object' &&
        'name' in err.cause &&
        err.cause.name === 'CLIError'
      ) {
        return E.fail(
          new CLIError({ cause: err as unknown as OriginalCLIError }),
        )
      } else return E.die(err)
    })

    return {
      // get: (name, flags) => {
      //   // E.try(() => item.get(name, flags))
      //   //   .pipe(
      //   //     E.catchAll((err) => {
      //   //       if (
      //   //         err.cause != null &&
      //   //         typeof err.cause === 'object' &&
      //   //         'name' in err.cause &&
      //   //         err.cause.name === 'CLIError'
      //   //       ) {
      //   //         return E.fail(
      //   //           new CLIError({ cause: err as unknown as OriginalCLIError }),
      //   //         )
      //   //       } else return E.die(err)
      //   //     }),
      //   //     E.tap((res) =>
      //   //       E.annotateCurrentSpan({ value: JSON.stringify(res) })
      //   //     ),
      //   //   )
      //   //   .pipe(E.withSpan('1password/get', { attributes: { name } })),

      //   if (flags == null || !('fields' in flags)) {
      //     return E.try(() => item.get(name, flags) as Item).pipe(handle_error)
      //   } else if (flags.fields.label.length === 1) {
      //     return E.try(() => item.get(name, flags) as ValueField).pipe(handle_error)
      //   } else if (flags.fields.label.length > 1) {
      //     return E.try(() => item.get(name, flags) as Array<ValueField>).pipe(handle_error)
      //   } else {
      //     return E.fail(new UnsupportedFlags({ flags }))
      //   }
      //   // const getter = Match.value(flags).pipe(
      //   //   Match.whenOr(
      //   //     Match.null,
      //   //     { fields: Match.undefined },
      //   //     (flags) => item.get(name, flags) as Item,
      //   //   ),
      //   //   Match.when({fields: Match.})
      //   // )
      // },
      getItem(name, flags) {
        return E.try(() => item.get(name, flags) as Item)
          .pipe(
            handle_error,
            E.tap((res) =>
              E.annotateCurrentSpan({ value: JSON.stringify(res) })
            ),
          )
          .pipe(E.withSpan('1password/get', { attributes: { name } }))
      },
      getFields(name, flags) {
        return E.try(() =>
          item.get(name, flags) as ValueField | Array<ValueField>
        )
          .pipe(
            handle_error,
            E.tap((res) =>
              E.annotateCurrentSpan({ value: JSON.stringify(res) })
            ),
            E.map((fields) => Array.isArray(fields) ? fields : [fields]),
          )
          .pipe(E.withSpan('1password/get', { attributes: { name } }))
      },
    }
  }),
)
